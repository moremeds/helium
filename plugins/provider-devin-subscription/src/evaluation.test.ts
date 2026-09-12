import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { WorkOrder } from "@helium/core";
import { ExecutionTargetId } from "@helium/core";
import type { AcpChild } from "./acp.js";
import createDevinEvaluation, { ISOLATION_CONFIG } from "./evaluation.js";

interface Stub extends AcpChild {
  stdout: EventEmitter;
  stderr: EventEmitter;
  bus: EventEmitter;
  written: string[];
  killed: string[];
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  answers: Map<string, (req: Record<string, unknown>) => unknown>;
  stdin: { write(chunk: string): unknown };
}

const frame = (payload: Record<string, unknown>) =>
  Buffer.from(JSON.stringify(payload) + "\n", "utf8");
const okFrame = (id: unknown, result: unknown) => frame({ jsonrpc: "2.0", id, result });

/**
 * The child answers each written request itself, on a macrotask so the client
 * finishes registering the pending id first. `kill` emits exit+close so the
 * client's close() in run()'s finally settles immediately; tests needing a
 * wedged child drive bus events manually instead.
 */
function stubChild(script: {
  promptResult?: unknown;
  promptText?: string;
  promptNotifications?: Array<Record<string, unknown>>;
  noPromptReply?: boolean;
  /** Bytes emitted after the terminal response but before close. */
  trailing?: string;
}): Stub {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const bus = new EventEmitter();
  const stub: Stub = {
    stdout, stderr, bus,
    written: [], killed: [], argv: [], env: {}, cwd: "",
    answers: new Map(),
    stdin: {
      write(chunk: string) {
        stub.written.push(chunk);
        let req: Record<string, unknown>;
        try { req = JSON.parse(chunk) as Record<string, unknown>; } catch { return true; }
        const method = req.method;
        if (typeof method !== "string") return true;
        setImmediate(() => {
          if (method === "session/prompt") {
            for (const n of script.promptNotifications ?? []) stdout.emit("data", frame(n));
            if (script.promptText !== undefined) {
              stdout.emit("data", frame({
                jsonrpc: "2.0", method: "session/update",
                params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: script.promptText } } },
              }));
            }
            if (script.noPromptReply === true) return;
            stdout.emit("data", okFrame(req.id, script.promptResult ?? { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 3 } }));
            if (script.trailing !== undefined) stdout.emit("data", Buffer.from(script.trailing, "utf8"));
            return;
          }
          if (method === "initialize") {
            stdout.emit("data", okFrame(req.id, { protocolVersion: 1, authMethods: [], agentInfo: { name: "stub" } }));
            return;
          }
          if (method === "session/new") {
            stdout.emit("data", okFrame(req.id, { sessionId: "s1" }));
            return;
          }
          const answer = stub.answers.get(method);
          if (answer !== undefined) stdout.emit("data", okFrame(req.id, answer(req)));
        });
        return true;
      },
    },
    on(event: string, cb: (...args: unknown[]) => void) { bus.on(event, cb); return bus; },
    kill(signal?: string) {
      stub.killed.push(signal ?? "SIGTERM");
      setImmediate(() => { bus.emit("exit", 0, null); bus.emit("close", 0, null); });
      return true;
    },
  } as unknown as Stub;
  return stub;
}

function make(outputDir: string, child: Stub, limits?: object) {
  const spawned: { argv: string[]; env: Record<string, string>; cwd: string }[] = [];
  const evaluation = createDevinEvaluation({
    outputDir,
    model: "swe-2-max",
    env: {
      HOME: "/home/test", PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-secret",
      OPENAI_API_KEY: "sk-secret-2", HTTPS_PROXY: "http://127.0.0.1:7897",
      CHISEL_SESSION_DB: "/ambient/should-not-survive.db",
      XDG_CONFIG_HOME: "/ambient/should-not-survive",
    },
    limits: { maxRequests: 4, timeoutMs: 20_000, maxRequestBytes: 8_192, ...(limits ?? {}) },
    spawn: (argv, options) => {
      spawned.push({ argv, env: options.env, cwd: options.cwd });
      child.argv = argv; child.env = options.env; child.cwd = options.cwd;
      return child;
    },
  });
  return { evaluation, spawned };
}

const work = (over: Partial<WorkOrder> = {}): WorkOrder => ({
  id: "w-1", role: "probe", taskClass: "diagnostic",
  requires: [], inputs: { artifacts: [], prompt: "Say hi." },
  constraints: { tools: [], mutations: "forbidden", minIsolationClass: "process" },
  acceptance: { outputSchema: "text" },
  ...over,
});

const selection = (extra?: Record<string, unknown>) => ({
  targetId: ExecutionTargetId("devin-subscription:swe-2-max"),
  model: "swe-2-max",
  options: { ...(extra ?? {}) },
});

const readJson = (dir: string, name: string) =>
  JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;

/**
 * A two-turn script: turn 1 answers with the given envelope text, turn 2 with
 * the final text. Bodies of later prompts are captured into `laterBodies`.
 */
function twoTurn(child: Stub, first: string, second: string, laterBodies: string[]) {
  let prompts = 0;
  const origWrite = child.stdin.write;
  child.stdin = {
    write(chunk: string) {
      const isPrompt = chunk.includes('"session/prompt"');
      if (!isPrompt) return origWrite(chunk);
      prompts += 1;
      const req = JSON.parse(chunk) as { id: unknown };
      if (prompts > 1) {
        const body = (JSON.parse(chunk) as { params: { prompt: Array<{ text: string }> } }).params.prompt[0]!.text;
        laterBodies.push(body);
      }
      const text = prompts === 1 ? first : second;
      setImmediate(() => {
        child.stdout.emit("data", frame({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } }));
        child.stdout.emit("data", okFrame(req.id, { stopReason: "end_turn", usage: { inputTokens: 10 + prompts, outputTokens: 3 + prompts } }));
      });
      return true;
    },
  };
}

const echoTool = () => ({
  name: "helium.echo", description: "echo test", paramsSchema: {} as never,
  mutating: false, run: vi.fn(async () => "TOOL_VALUE"),
});

describe("createDevinEvaluation offline (stub stdio transport)", () => {
  it("preserves the exact outbound request before dispatch and records known usage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devin-eval-"));
    const child = stubChild({ promptText: "{\"final\":\"DONE\"}" });
    const { evaluation } = make(dir, child);
    const out = await evaluation.provider.run!(work(), selection(), new AbortController().signal);
    expect(out.text).toBe("DONE");
    // request-1.json was reserved BEFORE the frame went out, state UNKNOWN.
    const reserved = readJson(dir, "request-1.json");
    expect(reserved.state).toBe("UNKNOWN");
    expect(reserved.requestedModel).toBe("swe-2-max");
    const wire = readFileSync(join(dir, "wire.ndjson"), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l) as { dir: string; frame: string });
    expect(wire.some((r) => r.dir === "out" && r.frame.includes('"method":"session/prompt"'))).toBe(true);
    // The recorded prompt body is the envelope + the original role prompt.
    expect(reserved.body).toContain("Say hi.");
    expect(reserved.body).toContain("final");
    const response = readJson(dir, "request-1-response.json");
    expect(response.state).toBe("RECORDED");
    expect(response.inputTokens).toBe(10);
    expect(response.outputTokens).toBe(3);
    const summary = evaluation.summary();
    expect(summary.unknown).toBe(false);
    expect(summary.requestCount).toBe(1);
    expect(summary.inputTokens).toBe(10);
    expect(summary.outputTokens).toBe(3);
    expect(summary.invocationUnit).toBe("ACP_INVOCATION");
  });

  it("spawns with an allowlisted env, scratch config, and the requested model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devin-eval-"));
    const child = stubChild({ promptText: "{\"final\":\"OK\"}" });
    const { evaluation, spawned } = make(dir, child);
    await evaluation.provider.run!(work(), selection(), new AbortController().signal);
    expect(spawned).toHaveLength(1);
    expect(child.argv).toEqual(["devin", "acp", "--agent-type", "summarizer", "--model", "swe-2-max"]);
    expect(child.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(child.env.OPENAI_API_KEY).toBeUndefined();
    expect(child.env.XDG_CONFIG_HOME).toBe(join(dir, "xdg-config"));
    expect(child.env.CHISEL_SESSION_DB).toBe(join(dir, "sessions.db"));
    expect(child.env.HOME).toBe("/home/test");
    expect(child.env.HTTPS_PROXY).toBe("http://127.0.0.1:7897");
    expect(child.cwd).toBe(join(dir, "scratch-cwd"));
    // The exact config bytes the child read, on disk under the scratch home.
    const written = JSON.parse(readFileSync(join(dir, "xdg-config", "devin", "config.json"), "utf8")) as Record<string, unknown>;
    expect(written).toEqual(JSON.parse(JSON.stringify(ISOLATION_CONFIG)));
    expect((written.read_config_from as Record<string, unknown>).claude).toBe(false);
    expect(written.subagents_enabled).toBe(false);
    // session/new advertised an empty MCP selection; initialize refused fs/terminal.
    expect(child.written.find((l) => l.includes('"session/new"'))).toContain('"mcpServers":[]');
    const initReq = child.written.find((l) => l.includes('"initialize"'));
    expect(initReq).toContain('"readTextFile":false');
    expect(initReq).toContain('"terminal":false');
  });

  it("executes one host tool round and returns the final answer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devin-eval-"));
    const tool = echoTool();
    const child = stubChild({});
    const laterBodies: string[] = [];
    twoTurn(child,
      "{\"tool_calls\":[{\"name\":\"helium.echo\",\"arguments\":{}}]}",
      "{\"final\":\"USED TOOL_VALUE\"}", laterBodies);
    const { evaluation } = make(dir, child);
    const w = work({ constraints: { tools: ["helium.echo"], mutations: "forbidden", minIsolationClass: "process" } });
    const out = await evaluation.provider.run!(w, selection({ tools: [tool] }), new AbortController().signal);
    expect(tool.run).toHaveBeenCalledTimes(1);
    expect(out.text).toBe("USED TOOL_VALUE");
    // The second prompt body carried the host tool result back to the model.
    expect(laterBodies[0]).toContain("TOOL_VALUE");
    expect(laterBodies[0]).toContain('"isError":false');
    const reserved2 = readJson(dir, "request-2.json");
    expect(reserved2.state).toBe("UNKNOWN");
    const summary = evaluation.summary();
    expect(summary.requestCount).toBe(2);
    expect(summary.inputTokens).toBe(23);
    expect(summary.outputTokens).toBe(9);
    const eventTypes = out.events.map((e) => e.type);
    expect(eventTypes).toContain("tool/call");
    expect(eventTypes).toContain("tool/result");
  });

  it("never executes a tool the role did not declare and reports the rejection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devin-eval-"));
    const tool = echoTool();
    const child = stubChild({});
    const laterBodies: string[] = [];
    twoTurn(child,
      "{\"tool_calls\":[{\"name\":\"shell.exec\",\"arguments\":{\"cmd\":\"rm -rf /\"}}]}",
      "{\"final\":\"REFUSED\"}", laterBodies);
    const { evaluation } = make(dir, child);
    const w = work({ constraints: { tools: ["helium.echo"], mutations: "forbidden", minIsolationClass: "process" } });
    const out = await evaluation.provider.run!(w, selection({ tools: [tool] }), new AbortController().signal);
    expect(out.text).toBe("REFUSED");
    expect(tool.run).not.toHaveBeenCalled();
    // The undeclared call produced an isError tool result, not an execution.
    expect(laterBodies[0]).toContain("no tool named shell.exec");
    expect(laterBodies[0]).toContain('"isError":true');
    const resultEvent = out.events.find((e) => e.type === "tool/result");
    expect((resultEvent!.data as { message: { isError: boolean } }).message.isError).toBe(true);
  });

  it("marks UNKNOWN when usage is absent and refuses any further dispatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devin-eval-"));
    const child = stubChild({ promptText: "{\"final\":\"NO USAGE\"}", promptResult: { stopReason: "end_turn" } });
    const { evaluation } = make(dir, child);
    await expect(
      evaluation.provider.run!(work(), selection(), new AbortController().signal),
    ).rejects.toThrow();
    const summary = evaluation.summary();
    expect(summary.unknown).toBe(true);
    expect(summary.inputTokens).toBeNull();
    expect(readJson(dir, "request-1-response.json").state).toBe("UNKNOWN");
    await expect(
      evaluation.provider.run!(work(), selection(), new AbortController().signal),
    ).rejects.toThrow();
    expect(evaluation.summary().requestCount).toBe(1);
  });

  it("marks UNKNOWN on timeout and issues session/cancel within its own budget", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devin-eval-"));
    const child = stubChild({ noPromptReply: true });
    child.answers.set("session/cancel", () => ({}));
    const { evaluation } = make(dir, child, { timeoutMs: 300 });
    await expect(
      evaluation.provider.run!(work(), selection(), new AbortController().signal),
    ).rejects.toThrow(/timeout/i);
    const summary = evaluation.summary();
    expect(summary.unknown).toBe(true);
    expect(summary.exhausted).toContain("timeoutMs");
    expect(child.written.some((l) => l.includes('"session/cancel"'))).toBe(true);
  });

  it("marks UNKNOWN on abort and stops the run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devin-eval-"));
    const child = stubChild({ noPromptReply: true });
    child.answers.set("session/cancel", () => ({}));
    const { evaluation } = make(dir, child);
    const controller = new AbortController();
    const pending = evaluation.provider.run!(work(), selection(), controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow();
    expect(evaluation.summary().unknown).toBe(true);
    expect(evaluation.summary().exhausted).toContain("cancelled");
  });

  it("fails closed on a malformed envelope while preserving the recorded request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devin-eval-"));
    const child = stubChild({ promptText: "not json at all" });
    const { evaluation } = make(dir, child);
    await expect(
      evaluation.provider.run!(work(), selection(), new AbortController().signal),
    ).rejects.toThrow(/envelope/i);
    const summary = evaluation.summary();
    expect(summary.unknown).toBe(true);
    const failureName = readdirSync(dir).find((n) => n.startsWith("failure-"));
    expect(readJson(dir, failureName!).state).toBe("UNKNOWN");
    expect(existsSync(join(dir, "request-1.json"))).toBe(true);
  });

  it("keeps trailing unparsed stdout as evidence after close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devin-eval-"));
    const child = stubChild({ promptText: "{\"final\":\"TAIL\"}", trailing: "unterminated-junk" });
    const { evaluation } = make(dir, child);
    const out = await evaluation.provider.run!(work(), selection(), new AbortController().signal);
    expect(out.text).toBe("TAIL");
    // kill() auto-emitted exit+close; settle flushed the decoder tail.
    const tailName = readdirSync(dir).find((n) => n.startsWith("stdout-tail-"));
    expect(tailName).toBeDefined();
    expect(readFileSync(join(dir, tailName!), "utf8")).toBe("unterminated-junk");
    expect(readFileSync(join(dir, "stdout.raw"), "utf8")).toContain("unterminated-junk");
  });

  it("never reuses artifact names across runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devin-eval-"));
    const child = stubChild({ promptText: "{\"final\":\"ONE\"}" });
    const { evaluation } = make(dir, child);
    await evaluation.provider.run!(work(), selection(), new AbortController().signal);
    await evaluation.provider.run!(work(), selection(), new AbortController().signal);
    const names = readdirSync(dir);
    expect(new Set(names).size).toBe(names.length);
    expect(existsSync(join(dir, "request-1.json"))).toBe(true);
    expect(existsSync(join(dir, "request-2.json"))).toBe(true);
    expect(names.filter((n) => n.startsWith("summary-")).length).toBeGreaterThanOrEqual(3);
  });

  it("refuses unknown or non-positive limit fields before anything spawns", () => {
    const child = stubChild({});
    expect(() => make(mkdtempSync(join(tmpdir(), "devin-eval-")), child, { maxOutputTokens: 5 })).toThrow(/limit fields/);
    expect(() => make(mkdtempSync(join(tmpdir(), "devin-eval-")), child, { maxRequests: 0 })).toThrow(/maxRequests/);
    expect(() => make(mkdtempSync(join(tmpdir(), "devin-eval-")), child, { timeoutMs: 2_147_483_648 })).toThrow(/timer limit/);
    expect(() => make(mkdtempSync(join(tmpdir(), "devin-eval-")), child, { timeoutMs: 1.5 })).toThrow(/timeoutMs/);
  });

  it("refuses a non-SWE-2 model id", () => {
    expect(() =>
      createDevinEvaluation({
        outputDir: mkdtempSync(join(tmpdir(), "devin-eval-")), model: "gpt-5-6-luna-none", env: {},
        limits: { maxRequests: 1, timeoutMs: 1_000, maxRequestBytes: 1_000 },
      }),
    ).toThrow(/SWE-2/);
  });

  it("records a capability shortage when a declared tool has no implementation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devin-eval-"));
    const child = stubChild({});
    const { evaluation } = make(dir, child);
    const w = work({ constraints: { tools: ["helium.missing"], mutations: "forbidden", minIsolationClass: "process" } });
    await expect(
      evaluation.provider.run!(w, selection(), new AbortController().signal),
    ).rejects.toMatchObject({ failureClass: "capability-shortage" });
    // The refusal happened before any session/prompt could dispatch.
    expect(child.written.some((l) => l.includes('"session/prompt"'))).toBe(false);
  });

  it("probe() finds devin only via the allowlisted PATH", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devin-eval-"));
    const child = stubChild({});
    const { evaluation } = make(dir, child);
    // The test env PATH is /usr/bin — devin is not there, so probe says no.
    expect(await evaluation.provider.probe()).toBe(false);
    expect(evaluation.provider.probeReason!()).toContain("devin binary");
  });
});
