/**
 * The Devin CLI's documented ACP surface as a stdio transport.
 *
 * `devin acp` speaks newline-delimited JSON-RPC over stdio. This client owns
 * the minimum an evaluation needs: spawn, `initialize`, `authenticate`,
 * `session/new`, `session/prompt`, `session/cancel`, and a clean shutdown.
 * Raw stdout/stderr chunks are handed to the caller as Buffers BEFORE parsing
 * so evidence keeps the exact bytes — including multibyte characters split
 * across chunks, which a per-chunk toString would corrupt. Line parsing uses
 * a StringDecoder precisely so it survives those splits.
 *
 * Lifecycle: the constructor spawns the child immediately and the caller
 * keeps the handle, so `close()` can kill a child whose `open()` handshake is
 * still in flight. `open()` and `prompt()` take explicit deadline budgets —
 * no step waits forever.
 * @module @helium/provider-devin-subscription/acp
 */
import { spawn as nodeSpawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/** The slice of ChildProcess the client drives; tests substitute a stub. */
export interface AcpChild {
  stdin: { write(chunk: string): unknown };
  stdout: { on(event: "data", cb: (chunk: Buffer) => void): unknown };
  stderr: { on(event: "data", cb: (chunk: Buffer) => void): unknown };
  on(event: "exit", cb: (code: number | null, signal: string | null) => void): unknown;
  on(event: "close", cb: (code: number | null, signal: string | null) => void): unknown;
  on(event: "error", cb: (error: Error) => void): unknown;
  kill(signal?: string): unknown;
}

export type AcpSpawn = (argv: string[], options: {
  cwd: string;
  env: Record<string, string>;
}) => AcpChild;

const defaultSpawn: AcpSpawn = (argv, options) =>
  nodeSpawn(argv[0]!, argv.slice(1), {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as unknown as AcpChild;

export interface AcpUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedReadTokens?: number;
}

export interface AcpPromptResult {
  /** Concatenated `agent_message_chunk` text for this prompt. */
  text: string;
  stopReason?: string;
  usage?: AcpUsage;
  /** `_cognition.ai/agent_stopped` fields, when the agent emitted them. */
  requestId?: string;
  agentStoppedCause?: string;
  toolCalls?: number;
  /** The wire's Model responseDimension — an agent-type label, not a revision. */
  modelLabel?: string;
}

interface PendingRequest {
  method: string;
  resolve: (message: Record<string, unknown>) => void;
}

export interface DevinAcpClientOptions {
  /** Full argv, e.g. ["devin", "acp", "--agent-type", "summarizer", "--model", "swe-2-max"]. */
  argv: string[];
  /** Session cwd — the scratch directory the session believes it works in. */
  cwd: string;
  /** The child's ENTIRE environment. The caller builds the allowlist. */
  env: Record<string, string>;
  spawn?: AcpSpawn;
  /** Raw stdout/stderr chunks, invoked BEFORE line parsing. Never re-encoded. */
  onStdoutBytes?(chunk: Buffer): void;
  onStderrBytes?(chunk: Buffer): void;
  /** One call per complete line, both directions, after it is framed. */
  onFrame?(direction: "out" | "in", line: string): void;
  /** Leftover unparsed stdout text once the stream is closed and drained. */
  onStdoutTail?(text: string): void;
  /** Every server notification, verbatim params. */
  onNotification?(method: string, params: unknown): void;
}

/** Race a request against a deadline, then ALWAYS clear the timer. */
function bounded<T>(promise: Promise<T>, ms: number): Promise<{ kind: "done"; value: T } | { kind: "timeout" }> {
  return new Promise((resolvePromise) => {
    let timer: NodeJS.Timeout;
    const finish = (outcome: { kind: "done"; value: T } | { kind: "timeout" }) => {
      clearTimeout(timer);
      resolvePromise(outcome);
    };
    timer = setTimeout(() => finish({ kind: "timeout" }), Math.max(1, ms));
    promise.then(
      (value) => finish({ kind: "done", value }),
      () => finish({ kind: "timeout" }),
    );
  });
}

export class DevinAcpClient {
  readonly child: AcpChild;
  spawnError: Error | undefined;
  #decoder = new StringDecoder("utf8");
  #buffer = "";
  #nextId = 0;
  #pending = new Map<string, PendingRequest>();
  #exited: { code: number | null; signal: string | null } | undefined;
  #closed = false;
  #onSettled: Array<() => void> = [];
  /** Notifications received since the last prompt() call began. */
  #promptNotifications: Record<string, unknown>[] = [];

  constructor(
    private readonly options: DevinAcpClientOptions,
  ) {
    this.child = (options.spawn ?? defaultSpawn)(options.argv, {
      cwd: options.cwd,
      env: options.env,
    });
    this.child.stdout.on("data", (chunk) => {
      options.onStdoutBytes?.(chunk);
      this.#buffer += this.#decoder.write(chunk);
      let index: number;
      while ((index = this.#buffer.indexOf("\n")) >= 0) {
        const line = this.#buffer.slice(0, index);
        this.#buffer = this.#buffer.slice(index + 1);
        if (line.trim() === "") continue;
        options.onFrame?.("in", line);
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          this.#notify("helium/malformed-frame", { line });
          continue;
        }
        this.#handle(message);
      }
    });
    this.child.stderr.on("data", (chunk) => {
      options.onStderrBytes?.(chunk);
    });
    // 'exit' can precede the final stdout/stderr data events; only 'close'
    // means the pipes are drained. A spawn failure emits 'error' and may never
    // emit 'exit' at all, so both paths funnel into #settle.
    this.child.on("exit", (code, signal) => {
      this.#exited = { code, signal };
    });
    this.child.on("error", (error) => {
      this.spawnError = error;
      this.#settle();
    });
    this.child.on("close", () => {
      this.#settle();
    });
  }

  #settle(): void {
    if (this.#closed) return;
    this.#closed = true;
    const tail = this.#decoder.end() + this.#buffer;
    this.#buffer = "";
    if (tail !== "") this.options.onStdoutTail?.(tail);
    for (const waiter of this.#onSettled.splice(0)) waiter();
    const detail = this.spawnError !== undefined
      ? `devin acp failed to spawn: ${this.spawnError.message}`
      : `devin acp exited (${String(this.#exited?.code)}/${String(this.#exited?.signal)})`;
    const error = { code: -32000, message: detail };
    for (const [, pending] of this.#pending) {
      pending.resolve({ jsonrpc: "2.0", id: null, error });
    }
    this.#pending.clear();
  }

  #notify(method: string, params: unknown): void {
    this.#promptNotifications.push({ method, params });
    this.options.onNotification?.(method, params);
  }

  #handle(message: Record<string, unknown>): void {
    const method = message.method;
    if (typeof method === "string" && message.id === undefined) {
      this.#notify(method, message.params);
      return;
    }
    if (typeof method === "string") {
      // Agent -> client request. No fs/terminal capability was advertised, so
      // nothing here may read files or spawn work: permission prompts are
      // cancelled and everything else is refused as unimplemented.
      if (method === "session/request_permission") {
        this.#send({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } });
      } else {
        this.#send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unimplemented: ${method}` } });
      }
      return;
    }
    const pending = this.#pending.get(String(message.id));
    if (pending !== undefined) {
      this.#pending.delete(String(message.id));
      pending.resolve(message);
    }
  }

  #send(message: Record<string, unknown>): void {
    const line = JSON.stringify(message);
    // The wire record is written BEFORE the bytes reach stdin — the outbound
    // frame must be durable even if the child dies on receipt.
    this.options.onFrame?.("out", line);
    this.child.stdin.write(line + "\n");
  }

  #request(method: string, params: unknown): Promise<Record<string, unknown>> {
    if (this.#closed) {
      const detail = this.spawnError !== undefined
        ? `devin acp failed to spawn: ${this.spawnError.message}`
        : "devin acp already exited";
      return Promise.resolve({ jsonrpc: "2.0", id: null, error: { code: -32000, message: detail } });
    }
    const id = `acp-${String(this.#nextId++)}`;
    return new Promise((resolve) => {
      this.#pending.set(id, { method, resolve });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /**
   * initialize -> authenticate -> session/new, each under one shared deadline.
   * Throws on any failure; the caller still owns `this` and can `close()` the
   * child no matter where the handshake stopped.
   */
  async open(timeoutMs: number): Promise<string> {
    const deadline = Date.now() + Math.max(1, timeoutMs);
    const step = async (name: string, promise: Promise<Record<string, unknown>>): Promise<Record<string, unknown>> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`devin acp ${name}: deadline`);
      const outcome = await bounded(promise, remaining);
      if (outcome.kind === "timeout") throw new Error(`devin acp ${name}: timed out`);
      const message = outcome.value;
      if (message.error !== undefined || message.result === undefined) {
        throw new Error(`devin acp ${name} failed: ${JSON.stringify(message.error ?? null)}`);
      }
      return message.result as Record<string, unknown>;
    };
    const init = await step("initialize", this.#request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "helium-devin-evaluation", version: "0.0.0" },
    }));
    const authMethods = (init as { authMethods?: Array<{ id?: unknown }> }).authMethods ?? [];
    const methodId = authMethods[0]?.id;
    if (typeof methodId === "string") {
      await step("authenticate", this.#request("authenticate", { methodId }));
    }
    const session = await step("session/new", this.#request("session/new", { cwd: this.options.cwd, mcpServers: [] }));
    const sessionId = (session as { sessionId?: unknown }).sessionId;
    if (typeof sessionId !== "string") throw new Error("devin acp session/new returned no sessionId");
    return sessionId;
  }

  /**
   * One `session/prompt` dispatch = one controlled invocation. The returned
   * usage is what the agent reported for THIS call; absent fields stay absent.
   */
  async prompt(sessionId: string, text: string): Promise<{ result?: AcpPromptResult; error?: unknown; notifications: Record<string, unknown>[] }> {
    this.#promptNotifications = [];
    const response = await this.#request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    });
    const notifications = this.#promptNotifications;
    if (response.error !== undefined) return { error: response.error, notifications };
    const result = (response.result ?? {}) as {
      stopReason?: string;
      usage?: AcpUsage;
    };
    let requestId: string | undefined;
    let agentStoppedCause: string | undefined;
    let toolCalls: number | undefined;
    let modelLabel: string | undefined;
    for (const notification of notifications) {
      if (notification.method !== "_cognition.ai/agent_stopped") continue;
      const params = notification.params as { cause?: unknown; stats?: Record<string, unknown> } | undefined;
      const stats = params?.stats ?? {};
      if (typeof stats.requestId === "string") requestId = stats.requestId;
      if (typeof stats.toolCalls === "number") toolCalls = stats.toolCalls;
      if (typeof params?.cause === "string") agentStoppedCause = params.cause;
      const dims = Array.isArray(stats.responseDimensions) ? stats.responseDimensions : [];
      for (const dim of dims as Array<{ uid?: unknown; kind?: { value?: unknown } }>) {
        if (dim?.uid === "model" && typeof dim.kind?.value === "string") modelLabel = dim.kind.value;
      }
    }
    const agentText = notifications
      .filter((n) => n.method === "session/update")
      .map((n) => (n.params as { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } }).update)
      .filter((u) => u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text")
      .map((u) => u!.content!.text!)
      .join("");
    return {
      result: {
        text: agentText,
        ...(result.stopReason === undefined ? {} : { stopReason: result.stopReason }),
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        ...(requestId === undefined ? {} : { requestId }),
        ...(agentStoppedCause === undefined ? {} : { agentStoppedCause }),
        ...(toolCalls === undefined ? {} : { toolCalls }),
        ...(modelLabel === undefined ? {} : { modelLabel }),
      },
      notifications,
    };
  }

  /** session/cancel is fire-and-bounded: the caller applies its own deadline. */
  async cancel(sessionId: string): Promise<Record<string, unknown>> {
    return this.#request("session/cancel", { sessionId });
  }

  /** SIGTERM, then SIGKILL after `graceMs` if the child has not closed. */
  async close(graceMs = 2000): Promise<void> {
    if (this.#closed) return;
    this.child.kill("SIGTERM");
    const deadline = Date.now() + graceMs;
    while (!this.#closed && Date.now() < deadline) {
      await new Promise<void>((resolveWait) => {
        this.#onSettled.push(() => resolveWait());
        setTimeout(resolveWait, Math.min(50, Math.max(1, deadline - Date.now())));
      });
    }
    if (!this.#closed) {
      this.child.kill("SIGKILL");
      const killDeadline = Date.now() + graceMs;
      while (!this.#closed && Date.now() < killDeadline) {
        await new Promise<void>((resolveWait) => {
          this.#onSettled.push(() => resolveWait());
          setTimeout(resolveWait, Math.min(50, Math.max(1, killDeadline - Date.now())));
        });
      }
    }
  }

  kill(): void {
    this.child.kill("SIGKILL");
  }
}
