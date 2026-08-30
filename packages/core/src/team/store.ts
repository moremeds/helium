/** Team-specific partitioning and projection over the generic event store. */
import { join } from "node:path";
import {
  openEventStore,
  type AppendedEvent,
  type SnapshotInfo,
} from "../event-store.js";
import { TeamEventSchema, type TeamEvent } from "./events.js";
import { reduceTeam, type TeamState } from "./reducer.js";

export interface TeamStoreOptions {
  sync?: (fd: number) => void;
}

export interface TeamStore {
  readonly caseId: string;
  readonly logPath: string;
  readonly snapshotPath: string;
  append(event: TeamEvent): AppendedEvent;
  events(): TeamEvent[];
  load(): TeamState;
  snapshot(): SnapshotInfo;
}

const PARTITION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export function openTeamStore(
  root: string,
  caseId: string,
  options: TeamStoreOptions = {},
): TeamStore {
  if (!PARTITION_ID.test(caseId)) {
    throw new Error(`invalid team case partition: ${caseId}`);
  }
  const backing = openEventStore(join(root, "cases", encodeURIComponent(caseId)), {
    schema: TeamEventSchema,
    ...(options.sync === undefined ? {} : { sync: options.sync }),
  });
  let projection = reduceTeam(backing.replay());

  return {
    caseId,
    logPath: backing.logPath,
    snapshotPath: backing.snapshotPath,

    append(event: TeamEvent): AppendedEvent {
      const validated = TeamEventSchema.parse(event);
      if (validated.caseId !== caseId) {
        throw new Error(
          `event case ${validated.caseId} does not match partition ${caseId}`,
        );
      }
      // Validate the transition before persistence, then persist before the
      // in-memory projection changes. An accepted event can therefore never
      // exist only in memory.
      const next = reduceTeam([validated], projection);
      const appended = backing.append(validated);
      projection = next;
      return appended;
    },

    events(): TeamEvent[] {
      return backing.replay();
    },

    load(): TeamState {
      projection = reduceTeam(backing.replay());
      return projection;
    },

    snapshot(): SnapshotInfo {
      return backing.snapshot();
    },
  };
}

