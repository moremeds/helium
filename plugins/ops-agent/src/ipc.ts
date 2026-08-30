/** Owner-only Unix-socket control surface for signed operator envelopes. */
import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { z } from "zod";
import {
  SignedApprovalEnvelopeSchema,
  SignedInterventionEnvelopeSchema,
  SignedSuggestionDecisionEnvelopeSchema,
  type ApprovalLedger,
  type OperatorEnvelopeVerifier,
  type SuggestionDecisionStorePort,
} from "./approval.js";
import type { OperationsStorePort } from "./controller.js";

const ControlRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("approve"),
    envelope: SignedApprovalEnvelopeSchema,
  }),
  z.strictObject({
    type: z.literal("record-intervention"),
    envelope: SignedInterventionEnvelopeSchema,
  }),
  z.strictObject({
    type: z.literal("record-suggestion-decision"),
    envelope: SignedSuggestionDecisionEnvelopeSchema,
  }),
]);
export type ControlRequest = z.infer<typeof ControlRequestSchema>;

interface ControlResponse {
  ok: boolean;
  value?: unknown;
  error?: string;
}

export interface OpsControlServerOptions {
  socketPath: string;
  approvals: ApprovalLedger;
  interventions: OperatorEnvelopeVerifier;
  suggestionDecisions: SuggestionDecisionStorePort;
  store: OperationsStorePort;
  now: () => Date;
  nextId?: (prefix: string) => string;
  maxRequestBytes?: number;
}

const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024;

export class OpsControlServer {
  #server: Server | undefined;
  #ownsSocket = false;
  #sequence = 0;

  constructor(private readonly options: OpsControlServerOptions) {}

  async start(): Promise<void> {
    if (this.#server !== undefined) throw new Error("ops control server already started");
    await reclaimStaleSocket(this.options.socketPath);

    const server = createServer((socket) => this.#serve(socket));
    this.#server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          this.#ownsSocket = true;
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.options.socketPath);
      });
      await chmod(this.options.socketPath, 0o600);
    } catch (error) {
      this.#server = undefined;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (this.#ownsSocket) {
        this.#ownsSocket = false;
        await unlink(this.options.socketPath).catch((unlinkError: unknown) => {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
        });
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
    if (this.#ownsSocket) {
      this.#ownsSocket = false;
      try {
        await unlink(this.options.socketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  #serve(socket: Socket): void {
    const maxBytes = this.options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    let bytes = 0;
    let buffer = "";
    let answered = false;

    const answer = (response: ControlResponse) => {
      if (answered) return;
      answered = true;
      socket.end(`${JSON.stringify(response)}\n`);
    };

    socket.on("data", (chunk: Buffer) => {
      if (answered) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        answer({ ok: false, error: `control request limit exceeded: ${bytes} > ${maxBytes}` });
        return;
      }
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      const remainder = buffer.slice(newline + 1);
      if (remainder.trim() !== "") {
        answer({ ok: false, error: "invalid control request: one request per connection" });
        return;
      }
      void this.#handle(line).then(answer, (error: unknown) =>
        answer({
          ok: false,
          error: error instanceof Error ? error.message : "invalid control request",
        }),
      );
    });
    socket.on("error", () => {
      // The client disappearing changes no state. Mutations happen only after
      // a complete verified envelope in #handle.
    });
  }

  async #handle(line: string): Promise<ControlResponse> {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error("invalid control request: malformed JSON");
    }
    const parsed = ControlRequestSchema.safeParse(raw);
    if (!parsed.success) throw new Error("invalid control request: unsupported shape");

    if (parsed.data.type === "approve") {
      const accepted = this.options.approvals.accept(parsed.data.envelope);
      return { ok: true, value: accepted };
    }

    if (parsed.data.type === "record-intervention") {
      const accepted = this.options.interventions.acceptIntervention(
        parsed.data.envelope,
      );
      this.options.store.append({
        v: 1,
        id: this.options.nextId?.("evt-operator-intervened") ??
          `evt-operator-intervened-${++this.#sequence}`,
        at: this.options.now().toISOString(),
        type: "operator-intervened",
        componentId: accepted.componentId,
        kind: accepted.interventionKind,
        confirmed: accepted.confirmed,
      });
      return { ok: true, value: { recorded: true, operatorId: accepted.operatorId } };
    }

    const proposed = parsed.data.envelope.decision;
    const action = this.options.store.state().actions[proposed.actionId];
    if (action === undefined || action.state !== "proposed") {
      throw new Error(`suggestion decision requires proposed action: ${proposed.actionId}`);
    }
    if (action.incidentId !== proposed.incidentId ||
        action.componentId !== proposed.componentId ||
        action.sopId !== proposed.sopId ||
        action.sopVersion !== proposed.sopVersion ||
        action.sopDigest !== proposed.sopDigest) {
      throw new Error(`suggestion decision does not match action: ${proposed.actionId}`);
    }
    if (this.options.suggestionDecisions.all().some(
      (value) => value.actionId === proposed.actionId,
    )) {
      throw new Error(`suggestion decision already recorded: ${proposed.actionId}`);
    }
    const accepted = this.options.interventions.acceptSuggestionDecision(
      parsed.data.envelope,
    );
    this.options.suggestionDecisions.record(accepted);
    return {
      ok: true,
      value: { recorded: true, actionId: accepted.actionId, operatorId: accepted.operatorId },
    };
  }
}

async function reclaimStaleSocket(path: string): Promise<void> {
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!before.isSocket()) {
    throw new Error(`refusing non-socket control path: ${path}`);
  }
  if (typeof process.getuid === "function" && before.uid !== process.getuid()) {
    throw new Error(`refusing control socket owned by another uid: ${path}`);
  }
  if (await socketAcceptsConnections(path)) {
    throw new Error(`refusing live control socket: ${path}`);
  }

  let after: Awaited<ReturnType<typeof lstat>>;
  try {
    after = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!after.isSocket() || after.dev !== before.dev || after.ino !== before.ino) {
    throw new Error(`control socket changed during stale check: ${path}`);
  }
  await unlink(path);
}

async function socketAcceptsConnections(path: string): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`control socket liveness check timed out: ${path}`));
    }, 500);
    const finish = (value: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
        finish(false);
        return;
      }
      clearTimeout(timer);
      reject(error);
    });
  });
}

export class OpsControlClient {
  constructor(
    private readonly socketPath: string,
    private readonly maxResponseBytes = DEFAULT_MAX_REQUEST_BYTES,
  ) {}

  async request(raw: unknown): Promise<unknown> {
    return await new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let bytes = 0;
      let buffer = "";
      socket.on("connect", () => {
        socket.write(`${JSON.stringify(raw)}\n`);
      });
      socket.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > this.maxResponseBytes) {
          socket.destroy();
          reject(new Error("control response limit exceeded"));
          return;
        }
        buffer += chunk.toString("utf8");
      });
      socket.on("error", reject);
      socket.on("end", () => {
        let response: ControlResponse;
        try {
          response = JSON.parse(buffer.trim()) as ControlResponse;
        } catch {
          reject(new Error("invalid control response"));
          return;
        }
        if (!response.ok) {
          reject(new Error(response.error ?? "control request refused"));
          return;
        }
        resolve(response.value);
      });
    });
  }
}
