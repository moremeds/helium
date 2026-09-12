/**
 * Controlled evaluation over the installed Devin CLI's ACP surface.
 *
 * Same contract as the Codex evaluation adapter: `runtime-evaluate` imports
 * `plugins/provider-devin-subscription/lib/evaluation.js` and calls the
 * default export. One fresh private namespace per trial; every
 * `session/prompt` dispatch is reserved with an UNKNOWN record BEFORE the
 * frame goes on the wire, and usage that never arrives keeps the run UNKNOWN.
 *
 * Deliberate differences from the Codex seam, because ACP is not an HTTP API:
 *  - limits are {maxRequests, timeoutMs, maxRequestBytes} ONLY. ACP offers no
 *    output-token or USD control, so those fields are rejected as unknown
 *    limit fields rather than silently unenforced.
 *  - the child environment is an ALLOWLIST, never a process.env spread:
 *    ambient credentials, tokens and unrelated settings cannot leak in.
 *  - tools are executed by THIS host loop: the no-tools `summarizer` agent
 *    sees a JSON envelope describing the role's offered tools, the host runs
 *    them via provider-sdk runToolCall, and results go back as the next
 *    prompt. No shell/MCP/general tool access is delegated to Devin.
 * @module @helium/provider-devin-subscription/evaluation
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, delimiter, isAbsolute } from "node:path";
import type { Provider, ProviderModel, LogEvent } from "@helium/core";
import { ExecutionTargetId, ProviderRunFailure } from "@helium/core";
import { MAX_TOOL_TURNS, parseToolArgs, runToolCall, selectedTools, toolCallEvents, toolSpecs } from "@helium/provider-sdk/tool-loop";
import { DevinAcpClient, type AcpSpawn, type AcpUsage } from "./acp.js";

export interface DevinEvaluationLimits {
  maxRequests: number;
  timeoutMs: number;
  maxRequestBytes: number;
}

export interface DevinEvaluationSummary {
  identityGrade: "ROUTE_ONLY";
  requestedModel: string;
  /** Agent-side model labels observed on the wire (e.g. "Summarizer") — NOT a verified serving revision. */
  reportedModelLabels: string[];
  sessionIds: string[];
  /** session/prompt dispatches — the only thing ACP meters. */
  requestCount: number;
  invocationUnit: "ACP_INVOCATION";
  inputTokens: number | null;
  outputTokens: number | null;
  knownInputTokens: number;
  knownOutputTokens: number;
  unknown: boolean;
  exhausted: string[];
  /** Constraints the work asked for that this transport cannot enforce. */
  unsupportedConstraints: string[];
  limits: DevinEvaluationLimits;
  artifacts: string[];
}

/** High is the observed no-tools route, not an independently pinned serving revision.
 * Cognition's SWE-2 model behavior describes High as a reasoning tier for
 * complex planning/verification; the installed catalog reports 262K context.
 * These routing capabilities are not evidence of tenant answer quality.
 */
export const DEVIN_EVALUATION_MODELS: ProviderModel[] = [
  {
    id: "swe-2-high",
    caps: ["reason.deep", "reason.fast", "code.edit", "code.review", "tool.use", "structured.output", "long.context"],
    usdIn: 0, usdOut: 0, unmetered: true, quotaDomain: "devin-subscription-session",
  },
];

/**
 * Router projection input ONLY — the tokens the agent spends before our
 * prompt is counted. Not yet measured: task-2 preflight evidence sets this;
 * until then 0 understates the true overhead and the summary's measured
 * totals are the accounting of record.
 */
export const DEVIN_OVERHEAD_TOKENS = 0;

/**
 * The child's entire environment is this list — nothing else survives.
 * Proxy variables stay because this machine's egress is proxied and dropping
 * them would silently break connectivity; XDG_CONFIG_HOME and
 * CHISEL_SESSION_DB are overwritten with the scratch namespace below.
 */
const ALLOWED_ENV = [
  "HOME", "PATH", "TMPDIR", "TERM", "TERM_PROGRAM", "COLORTERM",
  "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME", "SHELL",
  "__CF_USER_TEXT_ENCODING",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
] as const;

/**
 * Documented `read_config_from` switches — every importer off — plus
 * `subagents_enabled: false` to remove subagent tools. Builtin profile
 * descriptions remain intrinsic provider context. Exported so drivers/tests assert on the
 * exact bytes the child sees rather than a hand copy.
 */
export const ISOLATION_CONFIG = {
  version: 1,
  read_config_from: {
    agents_standard: false, cursor: false, windsurf: false,
    claude: false, copilot: false, opencode: false, zed: false,
  },
  subagents_enabled: false,
};

/** Native read denial for the remaining global skill importer. XDG redirects
 * Devin/Cognition config; this directory otherwise bypasses those redirects.
 * Builtin skills/profiles are provider preamble, not operator files.
 */
export const ISOLATION_PROFILE = `(version 1)
(allow default)
(deny file-read* (subpath (param "GLOBAL_SKILLS")))`;

/** The handshake gets this much of the remaining deadline at most. */
const CONNECT_BUDGET_MS = 60_000;
/** session/cancel is best-effort; this is its whole wait. */
const CANCEL_BUDGET_MS = 5_000;

function devinTargetId(modelId: string) {
  return ExecutionTargetId(`devin-subscription:${modelId}`);
}

function parseEnvelope(text: string): { final: string } | { toolCalls: Array<{ name: string; arguments?: unknown }> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    throw new ProviderRunFailure("schema-invalid", "devin-subscription: reply is not the declared JSON envelope");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProviderRunFailure("schema-invalid", "devin-subscription: reply is not the declared JSON envelope");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.final === "string") return { final: obj.final };
  if (Array.isArray(obj.tool_calls) &&
      (obj.tool_calls as unknown[]).every((c) => c !== null && typeof c === "object" && typeof (c as { name?: unknown }).name === "string")) {
    return { toolCalls: obj.tool_calls as Array<{ name: string; arguments?: unknown }> };
  }
  throw new ProviderRunFailure("schema-invalid", "devin-subscription: envelope has neither `final` nor `tool_calls`");
}

/** One turn's accounting, in the shape `foldSessionLog` reads. */
function turnEvents(seq: number, turn: number, startedAt: number, usage: AcpUsage | undefined): LogEvent[] {
  return [
    { type: "step/start", seq, time: startedAt, data: { turn, step: 1 } },
    {
      type: "assistant/message",
      seq: seq + 1,
      time: Date.now(),
      data: {
        turn,
        step: 1,
        usage: {
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
        },
      },
    },
  ];
}

/**
 * Race a prompt/cancel against a deadline and an abort signal. The losing
 * timer and the abort listener are ALWAYS removed — a settled race must not
 * keep the process alive or accumulate listeners across turns.
 */
function raceDeadline<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<
  { kind: "done"; value: T } | { kind: "timeout" } | { kind: "aborted" }
> {
  return new Promise((resolvePromise) => {
    let timer: NodeJS.Timeout;
    const onAbort = () => finish({ kind: "aborted" });
    const finish = (outcome: { kind: "done"; value: T } | { kind: "timeout" } | { kind: "aborted" }) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolvePromise(outcome);
    };
    if (signal?.aborted) {
      finish({ kind: "aborted" });
      return;
    }
    timer = setTimeout(() => finish({ kind: "timeout" }), Math.max(1, ms));
    signal?.addEventListener("abort", onAbort);
    promise.then(
      (value) => finish({ kind: "done", value }),
      () => finish({ kind: "timeout" }),
    );
  });
}

/** One fresh private namespace per trial. Existing namespaces cannot be resumed. */
export function createDevinEvaluation(options: {
  outputDir: string;
  model: string;
  env: NodeJS.ProcessEnv;
  limits: DevinEvaluationLimits;
  /** Test seam: substitute a stub child instead of spawning `devin acp`. */
  spawn?: AcpSpawn;
}): { provider: Provider; summary(): DevinEvaluationSummary } {
  const keys = ["maxRequests", "timeoutMs", "maxRequestBytes"] as const;
  if (!options.limits || typeof options.limits !== "object" || Array.isArray(options.limits) ||
      Object.keys(options.limits).some(key => !keys.some(allowed => allowed === key)))
    throw new Error("invalid evaluation limit fields");
  const limits = { ...options.limits };
  for (const name of keys) {
    const value = limits[name];
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid evaluation limit: ${name}`);
  }
  if (limits.timeoutMs > 2_147_483_647) throw new Error("evaluation timeout exceeds the timer limit");
  const model = DEVIN_EVALUATION_MODELS.find((candidate) => candidate.id === options.model);
  if (model === undefined) throw new Error("evaluation model must be swe-2-high (the supported SWE-2 no-tools route)");
  if (!options.env.HOME || !isAbsolute(options.env.HOME)) throw new Error("Devin isolation requires an absolute existing HOME");
  if (options.spawn === undefined && (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")))
    throw new Error("Devin evaluation isolation requires macOS sandbox-exec");
  const outputDir = resolve(options.outputDir);
  mkdirSync(outputDir, { mode: 0o700, recursive: true });
  // The scratch namespace the ACP child lives in: an empty session cwd plus a
  // private XDG config with every importer disabled. Nothing about the
  // operator's real ~/.config/devin reaches the session.
  const scratchCwd = join(outputDir, "scratch-cwd");
  const xdgHome = join(outputDir, "xdg-config");
  mkdirSync(join(scratchCwd, ".devin"), { recursive: true });
  mkdirSync(join(xdgHome, "devin"), { recursive: true });
  writeFileSync(join(xdgHome, "devin", "config.json"), JSON.stringify(ISOLATION_CONFIG, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  writeFileSync(join(scratchCwd, ".devin", "config.json"), JSON.stringify(ISOLATION_CONFIG, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  writeFileSync(join(scratchCwd, ".devin", "mcp_config.json"), JSON.stringify({ mcpServers: {} }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const sessionDb = join(outputDir, "sessions.db");
  const childEnv: Record<string, string> = {};
  for (const name of ALLOWED_ENV) {
    const value = options.env[name];
    if (typeof value === "string" && value !== "") childEnv[name] = value;
  }
  childEnv.XDG_CONFIG_HOME = xdgHome;
  childEnv.CHISEL_SESSION_DB = sessionDb;

  const deadline = Date.now() + limits.timeoutMs;
  const state: DevinEvaluationSummary = {
    identityGrade: "ROUTE_ONLY", requestedModel: model.id, reportedModelLabels: [], sessionIds: [],
    requestCount: 0, invocationUnit: "ACP_INVOCATION",
    inputTokens: 0, outputTokens: 0, knownInputTokens: 0, knownOutputTokens: 0,
    unknown: false, exhausted: [], unsupportedConstraints: [], limits, artifacts: [],
  };
  let revision = 0;
  let runIndex = 0;
  let activeRequest = "";
  let running = false;
  let stopped = false;
  const summary = (): DevinEvaluationSummary => structuredClone(state);
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
  // A function declaration (not a const arrow) so `stop()` calls actually
  // terminate control-flow analysis and narrow the guarded variable.
  function stop(reason: string): never {
    stopped = true;
    if (!state.exhausted.includes(reason)) state.exhausted.push(reason);
    persist();
    throw new Error(`Devin evaluation stopped: ${reason}`);
  }
  const known = (value: number | undefined): number | null =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

  const beforeRequest = (body: string, context?: { role: string }): void => {
    if (stopped || state.unknown) stop("unknown-or-stopped");
    if (state.requestCount >= limits.maxRequests) stop("maxRequests");
    const remaining = deadline - Date.now();
    if (remaining <= 0) stop("timeoutMs");
    if (Buffer.byteLength(body, "utf8") > limits.maxRequestBytes) stop("maxRequestBytes");
    // Reserve before dispatch; local persistence failures conservatively
    // consume a slot and require reconciliation.
    state.requestCount += 1;
    activeRequest = `request-${String(state.requestCount)}`;
    write(`${activeRequest}.json`, {
      requestId: activeRequest, state: "UNKNOWN", observedAt: new Date().toISOString(),
      requestedModel: model.id, role: context?.role ?? null, body, requestBytes: Buffer.byteLength(body, "utf8"),
    });
    state.unknown = true;
    state.inputTokens = null;
    state.outputTokens = null;
    persist();
    if (deadline - Date.now() <= 0) stop("timeoutMs");
  };

  const afterRequest = (outcome: {
    stopReason?: string; usage?: AcpUsage; requestId?: string; modelLabel?: string;
    agentStoppedCause?: string; toolCalls?: number; terminal?: string; error?: unknown;
  }): void => {
    const inputTokens = known(outcome.usage?.inputTokens);
    const outputTokens = known(outcome.usage?.outputTokens);
    const unknown = outcome.terminal !== undefined || outcome.error !== undefined ||
      inputTokens === null || outputTokens === null;
    state.knownInputTokens += inputTokens ?? 0;
    state.knownOutputTokens += outputTokens ?? 0;
    state.unknown = unknown;
    state.inputTokens = inputTokens === null ? null : state.knownInputTokens;
    state.outputTokens = outputTokens === null ? null : state.knownOutputTokens;
    if (outcome.modelLabel !== undefined && !state.reportedModelLabels.includes(outcome.modelLabel))
      state.reportedModelLabels.push(outcome.modelLabel);
    write(`${activeRequest}-response.json`, {
      requestId: activeRequest, observedAt: new Date().toISOString(), state: unknown ? "UNKNOWN" : "RECORDED",
      stopReason: outcome.stopReason ?? null, terminal: outcome.terminal ?? null,
      inputTokens, outputTokens,
      requestIdOnWire: outcome.requestId ?? null,
      reportedModelLabel: outcome.modelLabel ?? null,
      agentStoppedCause: outcome.agentStoppedCause ?? null,
      agentToolCalls: outcome.toolCalls ?? null,
      error: outcome.error === undefined ? null : String(outcome.error),
    });
    if (unknown) { stopped = true; state.exhausted.push("UNKNOWN"); }
    if (state.requestCount >= limits.maxRequests) state.exhausted.push("maxRequests");
    persist();
  };

  let probeReason = "devin binary not probed";
  const provider: Provider = {
    id: "devin-subscription",
    models: [model],
    capabilities: [...model.caps],
    overheadTokens: DEVIN_OVERHEAD_TOKENS,
    // ACP needs no credential probe: stored CLI credentials do the PKCE
    // handshake. The only local prerequisite is a resolvable `devin` binary.
    async probe() {
      const path = childEnv.PATH ?? "";
      const found = path.split(delimiter).some((dir) => dir !== "" && existsSync(join(dir, "devin")));
      probeReason = found ? "" : "devin binary not found on the child PATH";
      return found;
    },
    probeReason() { return probeReason; },
    select(request) {
      if (!request.requires.every((capability) => model.caps.includes(capability))) {
        throw new Error("evaluation model does not cover role capabilities");
      }
      return { targetId: devinTargetId(model.id), model: model.id };
    },
    async run(work, selection, signal) {
      if (running) throw new Error("Devin evaluation permits one worker only");
      if (selection.model !== model.id || selection.targetId !== devinTargetId(model.id)) throw new Error("evaluation route mismatch");
      if (stopped || state.unknown) stop("unknown-or-stopped");
      if (deadline - Date.now() <= 0) stop("timeoutMs");
      if (signal.aborted) stop("cancelled-before-dispatch");
      // The work order carries tool NAMES; the runner puts the IMPLEMENTATIONS
      // in selection.options.tools. Intersecting keeps the role's declared
      // permissions authoritative.
      const wanted = new Set(work.constraints.tools);
      const tools = selectedTools(selection.options).filter((tool) => wanted.has(tool.name));
      if (tools.length < wanted.size) {
        throw new ProviderRunFailure(
          "capability-shortage",
          `devin-subscription: role ${work.role} declares ${String(wanted.size)} tool(s), ` +
            `${String(tools.length)} implementation(s) reached the provider`,
        );
      }
      if (work.constraints.maxOutputTokens !== undefined &&
          !state.unsupportedConstraints.includes("maxOutputTokens"))
        state.unsupportedConstraints.push("maxOutputTokens");
      running = true;
      runIndex += 1;
      const tailName = `stdout-tail-run${String(runIndex)}.txt`;
      // Partial products survive a failed run inside the failure artifact.
      const said: string[] = [];
      const log: LogEvent[] = [];
      let client: DevinAcpClient | undefined;
      let failureArtifact: string | undefined;
      try {
        // The client exists BEFORE the handshake so a hung or failed open()
        // still leaves a killable child in the finally below.
        const argv = ["/usr/bin/sandbox-exec", "-p", ISOLATION_PROFILE, "-D", `GLOBAL_SKILLS=${join(childEnv.HOME!, ".agents", "skills")}`, "devin", "acp", "--agent-type", "summarizer", "--model", model.id];
        write(`launch-${String(runIndex)}.json`, { argv, cwd: scratchCwd, environmentKeys: Object.keys(childEnv).sort() });
        client = new DevinAcpClient({
          argv,
          cwd: scratchCwd,
          env: childEnv,
          ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
          onStdoutBytes: (chunk) => appendFileSync(join(outputDir, "stdout.raw"), chunk),
          onStderrBytes: (chunk) => appendFileSync(join(outputDir, "stderr.log"), chunk),
          onFrame: (direction, line) =>
            appendFileSync(join(outputDir, "wire.ndjson"), JSON.stringify({ t: Date.now(), dir: direction, frame: line }) + "\n", { flush: true }),
          onStdoutTail: (text) => writeFileSync(join(outputDir, tailName), text, { flag: "wx" }),
        });
        const sessionId = await client.open(Math.min(CONNECT_BUDGET_MS, Math.max(1, deadline - Date.now())));
        state.sessionIds.push(sessionId);
        const specs = toolSpecs(tools);
        const envelope = [
          "You are one step in a controlled helium evaluation. You have no tools of your own; a host executes offered tools for you.",
          "Reply with EXACTLY ONE JSON object and nothing else:",
          ...(specs.length > 0
            ? ["  {\"tool_calls\":[{\"name\":\"<offered tool>\",\"arguments\":{...}}]} — request host tool execution",
               `Offered tools (JSON schema): ${JSON.stringify(specs)}`]
            : []),
          "  {\"final\":\"<the complete step answer>\"} — finish the step",
          "",
          "Work order prompt:",
          work.inputs.prompt ?? JSON.stringify(work.inputs.artifacts),
        ].join("\n");

        let seq = 0;
        let body = envelope;
        for (let turn = 1; turn <= MAX_TOOL_TURNS; turn += 1) {
          const startedAt = Date.now();
          beforeRequest(body, { role: work.role });
          const perRequest = Math.min(work.constraints.maxLatencyMs ?? Number.MAX_SAFE_INTEGER, deadline - Date.now());
          const outcome = await raceDeadline(
            client.prompt(sessionId, body), Math.max(1, perRequest), signal,
          );
          const done = outcome.kind === "done" ? outcome.value : undefined;
          if (done === undefined) {
            // session/cancel is best-effort under its own small deadline;
            // the child is killed by close() regardless of the answer.
            await raceDeadline(client.cancel(sessionId), CANCEL_BUDGET_MS);
            afterRequest({ terminal: outcome.kind === "timeout" ? "timeout" : "cancelled" });
            stop(outcome.kind === "timeout" ? "timeoutMs" : "cancelled");
          }
          const { result, error } = done;
          afterRequest({
            ...(result?.stopReason === undefined ? {} : { stopReason: result.stopReason }),
            ...(result?.usage === undefined ? {} : { usage: result.usage }),
            ...(result?.requestId === undefined ? {} : { requestId: result.requestId }),
            ...(result?.modelLabel === undefined ? {} : { modelLabel: result.modelLabel }),
            ...(result?.agentStoppedCause === undefined ? {} : { agentStoppedCause: result.agentStoppedCause }),
            ...(result?.toolCalls === undefined ? {} : { toolCalls: result.toolCalls }),
            ...(error === undefined ? {} : { error }),
          });
          // UNKNOWN accounting blocks everything after it: no envelope parse,
          // no host tool side effects, no further dispatch.
          if (stopped || state.unknown) stop("unknown-or-stopped");
          if (result === undefined) {
            throw new ProviderRunFailure("provider-error", `devin-subscription ${model.id}: ${String(error)}`);
          }
          log.push(...turnEvents(seq, turn, startedAt, result.usage));
          seq += 2;
          const parsed = parseEnvelope(result.text);
          if ("final" in parsed) {
            said.push(parsed.final);
            return { text: said.join("\n"), events: log };
          }
          const results: Array<{ name: string; content: string; isError: boolean }> = [];
          for (const call of parsed.toolCalls) {
            if (stopped || state.unknown) stop("unknown-or-stopped");
            if (deadline - Date.now() <= 0) stop("timeoutMs");
            const callStarted = Date.now();
            const callId = `host-${String(turn)}-${String(results.length)}`;
            const toolOutcome = await runToolCall(tools, call.name, parseToolArgs(call.arguments));
            results.push({ name: call.name, content: toolOutcome.content, isError: toolOutcome.isError });
            log.push(...toolCallEvents(seq, turn, callId, call.name, callStarted, toolOutcome));
            seq += 2;
          }
          body = JSON.stringify({ tool_results: results });
        }
        // The tool-turn ceiling is a FAILURE: a truncated loop must never read
        // as a considered final answer. Partial text and tool outputs are
        // preserved in the failure artifact below.
        throw new ProviderRunFailure(
          "provider-error",
          `devin-subscription ${model.id}: exceeded ${String(MAX_TOOL_TURNS)} tool turns without a final answer`,
        );
      } catch (runError) {
        stopped = true;
        // beforeRequest/afterRequest own accounting uncertainty. A settled
        // malformed generation or a limit before the next dispatch is FAILED.
        failureArtifact = `failure-${String(revision)}.json`;
        write(failureArtifact, {
          state: state.unknown ? "UNKNOWN" : "FAILED", requestCount: state.requestCount,
          error: runError instanceof Error ? runError.message : String(runError),
          partialText: said, eventCount: log.length, events: log,
        });
        persist();
        throw runError;
      } finally {
        running = false;
        if (client !== undefined) {
          const drained = await client.close();
          if (!drained) {
            stopped = true;
            state.unknown = true;
            state.inputTokens = null;
            state.outputTokens = null;
          }
          write(`close-${String(runIndex)}.json`, {
            drained, state: state.unknown ? "UNKNOWN" : failureArtifact === undefined ? "COMPLETED" : "FAILED",
            priorFailure: failureArtifact ?? null,
            reason: drained ? null : "child-close-unconfirmed",
            transportError: client.transportError?.message ?? null,
          });
          if (!drained) stop("child-close-unconfirmed");
        }
      }
    },
  };
  persist();
  return { provider, summary };
}

export default createDevinEvaluation;
