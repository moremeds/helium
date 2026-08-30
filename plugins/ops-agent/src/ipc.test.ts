import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyOperationsState,
  reduceOperations,
  type OperationsState,
} from "@helium/core/operations/reducer.js";
import {
  OperationsEventSchema,
  type OperationsEvent,
} from "@helium/core/operations/events.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApprovalLedger,
  OperatorEnvelopeVerifier,
  approvalSigningPayload,
  interventionSigningPayload,
} from "./approval.js";
import type { OperationsStorePort } from "./controller.js";
import { OpsControlClient, OpsControlServer } from "./ipc.js";

const NOW = new Date("2026-08-30T00:00:00.000Z");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const dirs: string[] = [];

class MemoryStore implements OperationsStorePort {
  readonly events: OperationsEvent[] = [];
  #state: OperationsState = emptyOperationsState();
  append(raw: unknown): OperationsEvent {
    const event = OperationsEventSchema.parse(raw);
    this.#state = reduceOperations([event], this.#state);
    this.events.push(event);
    return event;
  }
  state() {
    return this.#state;
  }
  replay() {
    return [...this.events];
  }
}

const socketPath = () => {
  const dir = mkdtempSync(join(tmpdir(), "helium-ops-ipc-"));
  dirs.push(dir);
  return join(dir, "opsd.sock");
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function approval(nonce: string) {
  const unsigned = {
    kind: "approval" as const,
    operatorId: "operator-1",
    nonce,
    issuedAt: "2026-08-29T23:59:00.000Z",
    approval: {
      incidentId: "fixture|integrity|failed|fixture",
      sopId: "repair-fixture",
      sopVersion: 1,
      sopDigest: `sha256:${"a".repeat(64)}`,
      promotionId: "fixture-promotion",
      promotionInputSha256: "b".repeat(64),
      attempt: 1 as const,
      expiresAt: "2026-08-30T00:10:00.000Z",
    },
  };
  return {
    ...unsigned,
    signature: sign(null, approvalSigningPayload(unsigned), privateKey).toString(
      "base64",
    ),
  };
}

function intervention(nonce: string) {
  const unsigned = {
    kind: "intervention" as const,
    operatorId: "operator-1",
    nonce,
    issuedAt: "2026-08-29T23:59:00.000Z",
    expiresAt: "2026-08-30T00:10:00.000Z",
    intervention: {
      componentId: "fixture",
      interventionKind: "manual-repair",
      confirmed: true,
      at: NOW.toISOString(),
    },
  };
  return {
    ...unsigned,
    signature: sign(
      null,
      interventionSigningPayload(unsigned),
      privateKey,
    ).toString("base64"),
  };
}

async function server(path = socketPath(), maxRequestBytes?: number) {
  const store = new MemoryStore();
  const approvals = new ApprovalLedger({ trustedKey: publicKey, now: () => NOW });
  const instance = new OpsControlServer({
    socketPath: path,
    approvals,
    interventions: new OperatorEnvelopeVerifier({
      trustedKey: publicKey,
      now: () => NOW,
    }),
    store,
    now: () => NOW,
    ...(maxRequestBytes === undefined ? {} : { maxRequestBytes }),
  });
  await instance.start();
  return { instance, store, approvals, client: new OpsControlClient(path), path };
}

describe("OpsControlServer", () => {
  it("creates an owner-only unix socket", async () => {
    const { instance, path } = await server();
    try {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      await instance.stop();
    }
  });

  it("reclaims an owner-owned stale socket after an ungraceful process exit", async () => {
    const path = socketPath();
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const net=require('node:net'); const s=net.createServer(); s.listen(process.argv[1],()=>process.stdout.write('ready\\n')); setInterval(()=>{},1000)",
        path,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await once(child.stdout!, "data");
    child.kill("SIGKILL");
    await once(child, "exit");
    expect(existsSync(path)).toBe(true);

    const restarted = await server(path);
    try {
      await expect(
        restarted.client.request({
          type: "approve",
          envelope: approval("ipc-after-stale-socket"),
        }),
      ).resolves.toMatchObject({ sopId: "repair-fixture" });
    } finally {
      await restarted.instance.stop();
    }
  });

  it("refuses to unlink a live control socket", async () => {
    const live = await server();
    await expect(server(live.path)).rejects.toThrow(
      /live control socket|existing control socket/,
    );
    await live.instance.stop();
  });

  it("never removes an existing non-socket path it did not create", async () => {
    const path = socketPath();
    writeFileSync(path, "operator-owned\n", { mode: 0o600 });
    await expect(server(path)).rejects.toThrow(/non-socket/);
    expect(readFileSync(path, "utf8")).toBe("operator-owned\n");
  });

  it("accepts a signed scoped approval and rejects same-uid unsigned access", async () => {
    const { instance, client, approvals } = await server();
    try {
      await expect(
        client.request({ type: "approve", envelope: approval("ipc-approval-1") }),
      ).resolves.toMatchObject({ sopId: "repair-fixture", sopVersion: 1 });
      expect(
        approvals.find(
          "fixture|integrity|failed|fixture",
          "repair-fixture",
        ),
      ).toBeDefined();

      await expect(
        client.request({
          type: "approve",
          envelope: {
            ...approval("ipc-approval-unsigned"),
            signature: "same-uid-is-not-approval",
          },
        }),
      ).rejects.toThrow(/signature/);
    } finally {
      await instance.stop();
    }
  });

  it("records only a signed intervention through the authoritative store", async () => {
    const { instance, client, store } = await server();
    try {
      await client.request({
        type: "record-intervention",
        envelope: intervention("ipc-intervention-1"),
      });
      expect(store.events).toHaveLength(1);
      expect(store.events[0]).toMatchObject({
        type: "operator-intervened",
        componentId: "fixture",
        kind: "manual-repair",
        confirmed: true,
      });
    } finally {
      await instance.stop();
    }
  });

  it("has no request shape for direct execution, event append, or manifest reload", async () => {
    const { instance, client, store } = await server();
    try {
      for (const raw of [
        { type: "execute", argv: ["/bin/false"] },
        { type: "append-event", event: { type: "action-verified" } },
        { type: "reload-manifest", path: "/tmp/other.json" },
      ]) {
        await expect(client.request(raw)).rejects.toThrow(/invalid control request/);
      }
      expect(store.events).toEqual([]);
    } finally {
      await instance.stop();
    }
  });

  it("bounds request bytes before parsing", async () => {
    const { instance, client } = await server(undefined, 256);
    try {
      await expect(
        client.request({ type: "execute", padding: "x".repeat(1_000) }),
      ).rejects.toThrow(/request limit/);
    } finally {
      await instance.stop();
    }
  });
});
