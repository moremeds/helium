/** Pure, deterministic projection of the durable team event stream. */
import type { RoleContract, TeamEvent } from "./events.js";

export interface CaseProjection {
  caseId: string;
  subject: string;
  state: "open" | "closed";
  openedAt: string;
  closedAt?: string;
  closeReason?: string;
}

export interface RosterProjection {
  agentId: string;
  role: RoleContract;
  state: "idle";
}

export interface TeamRunProjection {
  teamRunId: string;
  caseId: string;
  state: "running" | "completed" | "failed" | "cancelled";
  roster: Record<string, RosterProjection>;
  startedAt: string;
  terminalAt?: string;
  terminalReason?: string;
}

export interface TeamState {
  cases: Record<string, CaseProjection>;
  teams: Record<string, TeamRunProjection>;
  eventIds: string[];
}

export function emptyTeamState(): TeamState {
  return { cases: {}, teams: {}, eventIds: [] };
}

const copyRole = (role: RoleContract): RoleContract => ({
  ...role,
  requires: [...role.requires],
  tools: [...role.tools],
});

export function reduceTeam(
  events: readonly TeamEvent[],
  initial: TeamState = emptyTeamState(),
): TeamState {
  const state: TeamState = {
    cases: Object.fromEntries(Object.entries(initial.cases).map(([id, value]) => [
      id,
      { ...value },
    ])),
    teams: Object.fromEntries(Object.entries(initial.teams).map(([id, value]) => [
      id,
      {
        ...value,
        roster: Object.fromEntries(Object.entries(value.roster).map(([agentId, agent]) => [
          agentId,
          { ...agent, role: copyRole(agent.role) },
        ])),
      },
    ])),
    eventIds: [...initial.eventIds],
  };
  const seen = new Set(state.eventIds);

  for (const event of events) {
    if (seen.has(event.eventId)) {
      throw new Error(`duplicate team event id: ${event.eventId}`);
    }
    seen.add(event.eventId);

    switch (event.type) {
      case "case/opened":
        if (state.cases[event.caseId] !== undefined) {
          throw new Error(`case already opened: ${event.caseId}`);
        }
        state.cases[event.caseId] = {
          caseId: event.caseId,
          subject: event.payload.subject,
          state: "open",
          openedAt: event.at,
        };
        break;

      case "case/closed": {
        const current = state.cases[event.caseId];
        if (current === undefined) throw new Error(`case/closed for unknown case: ${event.caseId}`);
        if (current.state === "closed") throw new Error(`case already terminal: ${event.caseId}`);
        current.state = "closed";
        current.closedAt = event.at;
        if (event.payload.reason !== undefined) current.closeReason = event.payload.reason;
        break;
      }

      case "team/started": {
        const owner = state.cases[event.caseId];
        if (owner === undefined) throw new Error(`team/started for unknown case: ${event.caseId}`);
        if (owner.state !== "open") throw new Error(`cannot start team for closed case: ${event.caseId}`);
        if (state.teams[event.teamRunId] !== undefined) {
          throw new Error(`team already started: ${event.teamRunId}`);
        }
        state.teams[event.teamRunId] = {
          teamRunId: event.teamRunId,
          caseId: event.caseId,
          state: "running",
          roster: {},
          startedAt: event.at,
        };
        break;
      }

      case "agent/rostered": {
        const team = state.teams[event.teamRunId];
        if (team === undefined) throw new Error(`agent/rostered for unknown team: ${event.teamRunId}`);
        if (team.caseId !== event.caseId) {
          throw new Error(`team ${event.teamRunId} belongs to case ${team.caseId}, not ${event.caseId}`);
        }
        if (team.state !== "running") throw new Error(`team already terminal: ${event.teamRunId}`);
        if (team.roster[event.payload.agentId] !== undefined) {
          throw new Error(`agent already rostered: ${event.payload.agentId}`);
        }
        team.roster[event.payload.agentId] = {
          agentId: event.payload.agentId,
          role: copyRole(event.payload.role),
          state: "idle",
        };
        break;
      }

      case "team/completed":
      case "team/failed":
      case "team/cancelled": {
        const team = state.teams[event.teamRunId];
        if (team === undefined) throw new Error(`${event.type} for unknown team: ${event.teamRunId}`);
        if (team.caseId !== event.caseId) {
          throw new Error(`team ${event.teamRunId} belongs to case ${team.caseId}, not ${event.caseId}`);
        }
        if (team.state !== "running") throw new Error(`team already terminal: ${event.teamRunId}`);
        team.state = event.type === "team/completed"
          ? "completed"
          : event.type === "team/failed"
            ? "failed"
            : "cancelled";
        team.terminalAt = event.at;
        if ("reason" in event.payload) team.terminalReason = event.payload.reason;
        break;
      }
    }

    state.eventIds.push(event.eventId);
  }

  return state;
}

