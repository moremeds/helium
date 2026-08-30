import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/event-store.js";
import {
  TeamEventSchema,
  type RoleContract,
  type TeamEvent,
} from "../src/team/events.js";
import { reduceTeam } from "../src/team/reducer.js";

const at = (minute: number) => `2026-08-30T06:${String(minute).padStart(2, "0")}:00.000Z`;

const leadRole: RoleContract = {
  roleId: "lead",
  requires: ["synthesis"],
  tools: ["artifact_read"],
  workspace: "isolated",
  maxDepth: 1,
  budgetShare: 0.5,
};

const opened: TeamEvent = {
  version: 1,
  eventId: "e1",
  at: at(0),
  caseId: "case-1",
  type: "case/opened",
  payload: { subject: "macro" },
};

const started: TeamEvent = {
  version: 1,
  eventId: "e2",
  at: at(1),
  caseId: "case-1",
  teamRunId: "team-1",
  type: "team/started",
  payload: {},
};

const rostered: TeamEvent = {
  version: 1,
  eventId: "e3",
  at: at(2),
  caseId: "case-1",
  teamRunId: "team-1",
  type: "agent/rostered",
  payload: { agentId: "lead", role: leadRole },
};

describe("team event schema", () => {
  it("is strict and keeps provider identity out of a role contract", () => {
    expect(() => TeamEventSchema.parse({
      ...rostered,
      payload: {
        ...rostered.payload,
        role: { ...leadRole, model: "forbidden" },
      },
    })).toThrow();
  });

  it("rejects unsupported event versions", () => {
    expect(() => TeamEventSchema.parse({ ...opened, version: 2 })).toThrow();
  });
});

describe("reduceTeam", () => {
  it("projects a case, running team, and stable roster identity", () => {
    expect(reduceTeam([opened, started, rostered])).toMatchObject({
      cases: { "case-1": { state: "open", subject: "macro" } },
      teams: {
        "team-1": {
          caseId: "case-1",
          state: "running",
          roster: { lead: { agentId: "lead", role: leadRole, state: "idle" } },
        },
      },
    });
  });

  it("rejects duplicate event IDs", () => {
    expect(() => reduceTeam([opened, { ...started, eventId: "e1" }])).toThrow(
      /duplicate team event id: e1/,
    );
  });

  it("rejects a team that references an unopened case", () => {
    expect(() => reduceTeam([started])).toThrow(/unknown case: case-1/);
  });

  it("rejects a roster entry for an unknown team", () => {
    expect(() => reduceTeam([opened, rostered])).toThrow(/unknown team: team-1/);
  });

  it("rejects a team event whose case does not own that team", () => {
    const otherOpened: TeamEvent = {
      ...opened,
      eventId: "e-other",
      caseId: "case-2",
      payload: { subject: "other" },
    };
    expect(() => reduceTeam([
      opened,
      otherOpened,
      started,
      { ...rostered, caseId: "case-2" },
    ])).toThrow(/team team-1 belongs to case case-1/);
  });

  it("rejects duplicate stable agent identities", () => {
    expect(() => reduceTeam([
      opened,
      started,
      rostered,
      { ...rostered, eventId: "e4", payload: { agentId: "lead", role: leadRole } },
    ])).toThrow(/agent already rostered: lead/);
  });

  it("rejects invalid terminal transitions", () => {
    const completed: TeamEvent = {
      version: 1,
      eventId: "e4",
      at: at(3),
      caseId: "case-1",
      teamRunId: "team-1",
      type: "team/completed",
      payload: {},
    };
    expect(() => reduceTeam([
      opened,
      started,
      completed,
      { ...completed, eventId: "e5", type: "team/failed", payload: { reason: "late" } },
    ])).toThrow(/already terminal/);
  });

  it("replays to byte-identical state", () => {
    const events = [opened, started, rostered];
    expect(canonicalJson(reduceTeam(events))).toBe(canonicalJson(reduceTeam(events)));
  });
});
