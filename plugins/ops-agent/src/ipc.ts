/** Owner-only Unix-socket control surface for signed operator envelopes. */
import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { z } from "zod";
import {
  SignedApprovalEnvelopeSchema,
  SignedInterventionEnvelopeSchema,
  type ApprovalLedger,
  type OperatorEnvelopeVerifier,
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
  store: OperationsStorePort;
  now: () => Date;
  nextId?: (prefix: string) => string;
  maxRequestBytes?: number;
}

const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024;

export class OpsControlServer {
  #server: Server | undefined;
  #sequence = 0;

  constructor(private readonly options: OpsControlServerOptions) {}

  async start(): Promise<void> {
    if (this.#server !== undefined) throw new Error("ops control server already started");
    try {
      await lstat(this.options.socketPath);
      throw new Error(`refusing existing control socket path: ${this.options.socketPath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const server = createServer((socket) => this.#serve(socket));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.options.socketPath);
    });
    await chmod(this.options.socketPath, 0o600);
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
    try {
      await unlink(this.options.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
