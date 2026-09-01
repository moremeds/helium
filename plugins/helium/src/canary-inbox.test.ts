import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { processCanaryInbox } from "./canary-inbox.js";

const now = () => new Date("2026-08-30T01:00:00.000Z");

function request(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    requestId: `canary-${"a".repeat(24)}`,
    caseKey: "weekend-smoke-1",
    tenant: "alpha",
    requestedBy: "weekend-operator",
    reason: "prove the review-only path",
    createdAt: "2026-08-30T00:55:00.000Z",
    expiresAt: "2026-08-30T01:30:00.000Z",
    ...over,
  };
}

describe("controlled canary inbox", () => {
  it("processes one strict request and archives both request and outcome", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-canary-inbox-"));
    const inbox = join(root, "requests");
    mkdirSync(inbox, { recursive: true });
    const value = request();
    writeFileSync(join(inbox, `${value.requestId}.json`), JSON.stringify(value));
    const handle = vi.fn(async () => {});

    const results = await processCanaryInbox({
      directory: inbox,
      knownTenants: new Set(["alpha"]),
      now,
      handle,
    });

    expect(results).toEqual([{ requestId: value.requestId, state: "completed" }]);
    expect(handle).toHaveBeenCalledWith(value);
    expect(existsSync(join(inbox, `${value.requestId}.json`))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, "processed", `${value.requestId}.outcome.json`), "utf8")))
      .toMatchObject({ requestId: value.requestId, state: "completed" });
  });

  it("quarantines expired, unknown-tenant, and malformed requests without invoking a team", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-canary-inbox-"));
    const inbox = join(root, "requests");
    mkdirSync(inbox, { recursive: true });
    const expired = request({ requestId: `canary-${"b".repeat(24)}`, expiresAt: "2026-08-30T00:59:59.000Z" });
    const unknown = request({ requestId: `canary-${"c".repeat(24)}`, tenant: "other" });
    writeFileSync(join(inbox, `${expired.requestId}.json`), JSON.stringify(expired));
    writeFileSync(join(inbox, `${unknown.requestId}.json`), JSON.stringify(unknown));
    writeFileSync(join(inbox, "bad.json"), "{");
    const handle = vi.fn(async () => {});

    const results = await processCanaryInbox({
      directory: inbox,
      knownTenants: new Set(["alpha"]),
      now,
      handle,
    });

    expect(results).toHaveLength(3);
    expect(results.every((entry) => entry.state === "rejected")).toBe(true);
    expect(handle).not.toHaveBeenCalled();
  });

  it("archives a pressure refusal as failed so it cannot busy-loop", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-canary-inbox-"));
    const inbox = join(root, "requests");
    mkdirSync(inbox, { recursive: true });
    const value = request();
    writeFileSync(join(inbox, `${value.requestId}.json`), JSON.stringify(value));

    const results = await processCanaryInbox({
      directory: inbox,
      knownTenants: new Set(["alpha"]),
      now,
      handle: async () => { throw new Error("host-memory-pressure"); },
    });

    expect(results).toEqual([{
      requestId: value.requestId,
      state: "failed",
      error: "host-memory-pressure",
    }]);
    expect(existsSync(join(inbox, `${value.requestId}.json`))).toBe(false);
  });
});
