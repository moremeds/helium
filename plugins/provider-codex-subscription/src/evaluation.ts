import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Provider } from "@helium/core";
import { CodexSubscriptionProvider, CODEX_MODELS, codexTargetId } from "./provider.js";
import type { CodexInvocationObserver } from "./invoke.js";

export interface CodexEvaluationLimits {
  maxRequests: number;
  timeoutMs: number;
  maxOutputTokens: number;
  maxRequestBytes: number;
}

export interface CodexEvaluationSummary {
  identityGrade: "ROUTE_ONLY";
  requestedModel: string;
  reportedModels: string[];
  requestCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  knownInputTokens: number;
  knownOutputTokens: number;
  unknown: boolean;
  exhausted: string[];
  limits: CodexEvaluationLimits;
  artifacts: string[];
}

/** One fresh private namespace per trial. Existing namespaces cannot be resumed. */
export function createCodexEvaluation(options: {
  outputDir: string;
  model: string;
  env: NodeJS.ProcessEnv;
  limits: CodexEvaluationLimits;
}): { provider: Provider; summary(): CodexEvaluationSummary } {
  const keys = ["maxRequests", "timeoutMs", "maxOutputTokens", "maxRequestBytes"] as const;
  if (!options.limits || typeof options.limits !== "object" || Array.isArray(options.limits) ||
      Object.keys(options.limits).some(key => !keys.some(allowed => allowed === key)))
    throw new Error("invalid evaluation limit fields");
  const limits = { ...options.limits };
  for (const name of keys) {
    const value = limits[name];
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid evaluation limit: ${name}`);
  }
  if (limits.timeoutMs > 2_147_483_647) throw new Error("evaluation timeout exceeds the timer limit");
  const model = CODEX_MODELS.find((candidate) => candidate.id === options.model);
  if (model === undefined) throw new Error("evaluation model must be an existing Codex model");
  const outputDir = resolve(options.outputDir);
  mkdirSync(outputDir, { mode: 0o700 });
  const deadline = Date.now() + limits.timeoutMs;
  const state: CodexEvaluationSummary = {
    identityGrade: "ROUTE_ONLY", requestedModel: model.id, reportedModels: [], requestCount: 0,
    inputTokens: 0, outputTokens: 0, knownInputTokens: 0, knownOutputTokens: 0,
    unknown: false, exhausted: [], limits, artifacts: [],
  };
  let revision = 0;
  let activeRequest = "";
  let running = false;
  let stopped = false;
  const summary = (): CodexEvaluationSummary => structuredClone(state);
  const write = (name: string, value: unknown): void => {
    const path = join(outputDir, name);
    try {
      writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600, flush: true });
    } catch (error) {
      stopped = true;
      state.unknown = true;
      state.inputTokens = null;
      state.outputTokens = null;
      throw error;
    }
    state.artifacts.push(path);
  };
  // Append-only snapshots retain every attempt even when run() throws.
  const persist = (): void => {
    write(`summary-${String(revision++)}.json`, summary());
  };
  const stop = (reason: string): never => {
    stopped = true;
    if (!state.exhausted.includes(reason)) state.exhausted.push(reason);
    persist();
    throw new Error(`Codex evaluation stopped: ${reason}`);
  };
  const known = (value: number | undefined): number | null =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const observer: CodexInvocationObserver = {
    beforeRequest(body, requestTimeoutMs, context) {
      if (stopped || state.unknown) stop("unknown-or-stopped");
      if (state.requestCount >= limits.maxRequests) stop("maxRequests");
      const remaining = deadline - Date.now();
      if (remaining <= 0) stop("timeoutMs");
      if (Buffer.byteLength(body, "utf8") > limits.maxRequestBytes) stop("maxRequestBytes");
      // ponytail: reserve before dispatch; local persistence failures conservatively consume a slot and require reconciliation.
      state.requestCount += 1;
      activeRequest = `request-${String(state.requestCount)}`;
      // Dispatch may follow this write. Until a response is saved its accounting is UNKNOWN.
      write(`${activeRequest}.json`, {
        requestId: activeRequest, state: "UNKNOWN", observedAt: new Date().toISOString(),
        requestedModel: model.id, role: context?.role ?? null, body, requestBytes: Buffer.byteLength(body, "utf8"),
      });
      state.unknown = true;
      state.inputTokens = null;
      state.outputTokens = null;
      persist();
      const dispatchRemaining = deadline - Date.now();
      if (dispatchRemaining <= 0) stop("timeoutMs");
      return Math.min(requestTimeoutMs, dispatchRemaining);
    },
    afterRequest(response, usage, reportedModel, completed) {
      const inputTokens = known(usage.inputTokens);
      const outputTokens = known(usage.outputTokens);
      const incomplete = response.terminal !== undefined || completed !== true;
      const unknown = incomplete || inputTokens === null || outputTokens === null;
      state.knownInputTokens += inputTokens ?? 0;
      state.knownOutputTokens += outputTokens ?? 0;
      state.unknown = unknown;
      state.inputTokens = incomplete || inputTokens === null ? null : state.knownInputTokens;
      state.outputTokens = incomplete || outputTokens === null ? null : state.knownOutputTokens;
      if (reportedModel !== undefined && !state.reportedModels.includes(reportedModel)) state.reportedModels.push(reportedModel);
      write(`${activeRequest}-response.json`, {
        requestId: activeRequest, observedAt: new Date().toISOString(), state: unknown ? "UNKNOWN" : "RECORDED",
        status: response.status, completed: completed === true, terminal: response.terminal ?? null, body: response.body,
        inputTokens, outputTokens, reportedModel: reportedModel ?? null,
      });
      if (unknown) { stopped = true; state.exhausted.push("UNKNOWN"); }
      if (state.requestCount >= limits.maxRequests) state.exhausted.push("maxRequests");
      persist();
      return !unknown;
    },
  };
  const underlying = new CodexSubscriptionProvider({ ...options.env }, { observer, maxOutputTokens: limits.maxOutputTokens });
  const provider: Provider = {
    id: underlying.id, models: [model], capabilities: [...model.caps], overheadTokens: underlying.overheadTokens,
    // Evaluation does not perform a second, unrecorded network probe.
    async probe() { return true; },
    select(request) {
      if (!request.requires.every((capability) => model.caps.includes(capability))) {
        throw new Error("evaluation model does not cover role capabilities");
      }
      const selection = underlying.select(request);
      return { ...selection, model: model.id, targetId: codexTargetId(model.id) };
    },
    async run(work, selection, signal) {
      if (running) throw new Error("Codex evaluation permits one worker only");
      if (selection.model !== model.id || selection.targetId !== codexTargetId(model.id)) throw new Error("evaluation route mismatch");
      if (stopped || state.unknown) stop("unknown-or-stopped");
      const remaining = deadline - Date.now();
      if (remaining <= 0) stop("timeoutMs");
      if (signal.aborted) stop("cancelled-before-dispatch");
      running = true;
      try {
        return await underlying.run(work, selection, AbortSignal.any([signal, AbortSignal.timeout(remaining)]));
      } catch (error) {
        stopped = true;
        write(`failure-${String(revision)}.json`, { state: state.unknown ? "UNKNOWN" : "FAILED", requestCount: state.requestCount });
        persist();
        throw error;
      } finally {
        running = false;
      }
    },
  };
  persist();
  return { provider, summary };
}

export default createCodexEvaluation;
