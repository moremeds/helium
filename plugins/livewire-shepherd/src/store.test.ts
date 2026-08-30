import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkUnit } from "./work-unit.js";
import { openShepherdStore } from "./store.js";

const noSync = () => {};
const now = "2026-08-31T01:00:00.000Z";

function root(): string {
  return mkdtempSync(join(tmpdir(), "helium-shepherd-store-"));
}

function unit() {
  return createWorkUnit({
    kind: "index-revision",
    indexId: "sp500",
    asOf: now,
    sourceRevisionRefs: [{
      ref: "artifact://wiki/sp500/123",
      hash: `sha256:${"a".repeat(64)}`,
    }],
  });
}

describe("openShepherdStore", () => {
  it("reopens, replays, and snapshots the authoritative event log", () => {
    const directory = root();
    const first = openShepherdStore(directory, { sync: noSync });
    const work = unit();
    first.append({
      version: 1,
      eventId: "discover-1",
      at: now,
      type: "work-unit/discovered",
      payload: { unit: work },
    });
    first.snapshot();

    const reopened = openShepherdStore(directory, { sync: noSync });
    expect(reopened.events()).toHaveLength(1);
    expect(reopened.load().workUnits[work.workUnitId]?.state).toBe("DISCOVERED");
  });

  it("repairs a torn final append before accepting the next event", () => {
    const directory = root();
    const first = openShepherdStore(directory, { sync: noSync });
    const work = unit();
    first.append({
      version: 1,
      eventId: "discover-1",
      at: now,
      type: "work-unit/discovered",
      payload: { unit: work },
    });
    appendFileSync(first.logPath, '{"torn":');

    const reopened = openShepherdStore(directory, { sync: noSync });
    reopened.append({
      version: 1,
      eventId: "wait-1",
      at: now,
      type: "work-unit/transitioned",
      payload: {
        workUnitId: work.workUnitId,
        expectedRevision: 0,
        revision: 1,
        from: "DISCOVERED",
        to: "AWAITING_PROVIDER",
        reason: "fixture",
      },
    });
    expect(openShepherdStore(directory, { sync: noSync }).events()).toHaveLength(2);
  });

  it("verifies attached CAS bytes on append and every replay", () => {
    const directory = root();
    const store = openShepherdStore(directory, { sync: noSync });
    const work = unit();
    store.append({
      version: 1,
      eventId: "discover-1",
      at: now,
      type: "work-unit/discovered",
      payload: { unit: work },
    });
    const saved = store.artifacts.put("source bytes");
    store.append({
      version: 1,
      eventId: "evidence-1",
      at: now,
      type: "evidence/attached",
      payload: {
        workUnitId: work.workUnitId,
        expectedRevision: 0,
        revision: 1,
        evidence: { ref: "artifact://logical/source", hash: saved.hash },
      },
    });

    const contentPath = join(store.artifactRoot, saved.hash.slice("sha256:".length));
    writeFileSync(contentPath, "tampered");
    expect(() => store.load()).toThrow(/hash mismatch/i);
    expect(readFileSync(store.logPath, "utf8")).toContain("artifact://logical/source");
  });

  it("rejects an evidence event when its bytes are absent", () => {
    const store = openShepherdStore(root(), { sync: noSync });
    const work = unit();
    store.append({
      version: 1,
      eventId: "discover-1",
      at: now,
      type: "work-unit/discovered",
      payload: { unit: work },
    });
    expect(() => store.append({
      version: 1,
      eventId: "evidence-1",
      at: now,
      type: "evidence/attached",
      payload: {
        workUnitId: work.workUnitId,
        expectedRevision: 0,
        revision: 1,
        evidence: { ref: "artifact://logical/missing", hash: `sha256:${"f".repeat(64)}` },
      },
    })).toThrow();
  });
});
