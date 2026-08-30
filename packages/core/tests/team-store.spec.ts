import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../src/event-store.js";
import type { RoleContract, TeamEvent } from "../src/team/events.js";
import { reduceTeam } from "../src/team/reducer.js";
import { openTeamStore } from "../src/team/store.js";

const root = () => mkdtempSync(join(tmpdir(), "helium-team-store-"));
const noSync = () => {};
const at = (minute: number) => `2026-08-30T07:${String(minute).padStart(2, "0")}:00.000Z`;
const role: RoleContract = {
  roleId: "lead",
  requires: ["synthesis"],
  tools: ["artifact_read"],
  workspace: "isolated",
  maxDepth: 1,
  budgetShare: 1,
};
const opened: TeamEvent = {
  version: 1,
  eventId: "store-e1",
  at: at(0),
  caseId: "case-store",
  type: "case/opened",
  payload: { subject: "macro" },
};
const started: TeamEvent = {
  version: 1,
  eventId: "store-e2",
  at: at(1),
  caseId: "case-store",
  teamRunId: "team-store",
  type: "team/started",
  payload: {},
};
const rostered: TeamEvent = {
  version: 1,
  eventId: "store-e3",
  at: at(2),
  caseId: "case-store",
  teamRunId: "team-store",
  type: "agent/rostered",
  payload: { agentId: "lead", role },
};

describe("team store", () => {
  it("appends before projecting and replays the same state after restart", () => {
    const path = root();
    const store = openTeamStore(path, "case-store", { sync: noSync });
    store.append(opened);
    store.append(started);
    store.snapshot();
    store.append(rostered);

    expect(store.load()).toEqual(reduceTeam([opened, started, rostered]));
    expect(openTeamStore(path, "case-store", { sync: noSync }).load())
      .toEqual(reduceTeam([opened, started, rostered]));
  });

  it("crosses the supplied fsync boundary once per accepted event", () => {
    const sync = vi.fn();
    const store = openTeamStore(root(), "case-store", { sync });
    store.append(opened);
    store.append(started);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("does not append a semantically invalid event", () => {
    const store = openTeamStore(root(), "case-store", { sync: noSync });
    expect(() => store.append(started)).toThrow(/unknown case/);
    expect(store.events()).toEqual([]);
  });

  it("refuses to mix cases in one partition", () => {
    const store = openTeamStore(root(), "case-store", { sync: noSync });
    expect(() => store.append({ ...opened, caseId: "case-other" })).toThrow(
      /event case case-other does not match partition case-store/,
    );
  });

  it("repairs a truncated final event and remains append-safe", () => {
    const path = root();
    const store = openTeamStore(path, "case-store", { sync: noSync });
    store.append(opened);
    store.append(started);
    store.snapshot();
    store.append(rostered);
    const raw = readFileSync(store.logPath);
    truncateSync(store.logPath, raw.length - 20);

    const reopened = openTeamStore(path, "case-store", { sync: noSync });
    expect(reopened.events()).toEqual([opened, started]);
    reopened.append(rostered);
    expect(openTeamStore(path, "case-store", { sync: noSync }).events())
      .toEqual([opened, started, rostered]);
  });

  it("ignores a corrupt snapshot and replays the authoritative log", () => {
    const path = root();
    const store = openTeamStore(path, "case-store", { sync: noSync });
    store.append(opened);
    store.append(started);
    store.snapshot();
    const snapshot = JSON.parse(readFileSync(store.snapshotPath, "utf8"));
    snapshot.lastHash = "sha256:tampered";
    writeFileSync(store.snapshotPath, JSON.stringify(snapshot));
    chmodSync(store.snapshotPath, 0o600);

    expect(openTeamStore(path, "case-store", { sync: noSync }).load())
      .toEqual(reduceTeam([opened, started]));
  });

  it("rejects an unsupported event version in the log", () => {
    const path = root();
    const store = openTeamStore(path, "case-store", { sync: noSync });
    store.append(opened);
    const envelope = JSON.parse(readFileSync(store.logPath, "utf8"));
    envelope.record.version = 2;
    envelope.hash = `sha256:${createHash("sha256").update(canonicalJson(envelope.record)).digest("hex")}`;
    writeFileSync(store.logPath, `${JSON.stringify(envelope)}\n`);
    chmodSync(store.logPath, 0o600);
    expect(() => openTeamStore(path, "case-store", { sync: noSync })).toThrow();
  });
});
