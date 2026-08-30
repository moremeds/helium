import { join } from "node:path";
import {
  ContentAddressedArtifactStore,
  openEventStore,
  type AppendedEvent,
  type SnapshotInfo,
} from "@helium/core";
import { ShepherdEventSchema, type ShepherdEvent } from "./events.js";
import { reduceShepherd, type ShepherdProjection } from "./reducer.js";
import type { HashedArtifactRef } from "./work-unit.js";

export interface ShepherdStoreOptions {
  sync?: (fd: number) => void;
}

export interface ShepherdStore {
  readonly logPath: string;
  readonly snapshotPath: string;
  readonly artifactRoot: string;
  readonly artifacts: ContentAddressedArtifactStore;
  append(event: ShepherdEvent): AppendedEvent;
  events(): ShepherdEvent[];
  load(): ShepherdProjection;
  snapshot(): SnapshotInfo;
}

export function openShepherdStore(
  root: string,
  options: ShepherdStoreOptions = {},
): ShepherdStore {
  const openEvents = () => openEventStore(join(root, "events"), {
      schema: ShepherdEventSchema,
      ...(options.sync === undefined ? {} : { sync: options.sync }),
    });
  const initialEventStore = openEvents();
  const artifactRoot = join(root, "artifacts");
  const artifacts = new ContentAddressedArtifactStore(artifactRoot, options);
  let projection = loadVerified(initialEventStore.replay(), artifacts);

  return {
    logPath: initialEventStore.logPath,
    snapshotPath: initialEventStore.snapshotPath,
    artifactRoot,
    artifacts,

    append(event: ShepherdEvent): AppendedEvent {
      const parsed = ShepherdEventSchema.parse(event);
      verifyEventEvidence(parsed, artifacts);
      // A Shepherd process may remain alive while another process appends.
      // Reopen here so the sequence/hash anchor is read from disk inside the
      // caller's cross-process coordination section, never from startup cache.
      const eventStore = openEvents();
      const next = reduceShepherd([...eventStore.replay(), parsed]);
      const appended = eventStore.append(parsed);
      projection = next;
      return appended;
    },

    events(): ShepherdEvent[] {
      return openEvents().replay();
    },

    load(): ShepherdProjection {
      projection = loadVerified(openEvents().replay(), artifacts);
      return projection;
    },

    snapshot(): SnapshotInfo {
      return openEvents().snapshot();
    },
  };
}

function loadVerified(
  events: ShepherdEvent[],
  artifacts: ContentAddressedArtifactStore,
): ShepherdProjection {
  for (const event of events) verifyEventEvidence(event, artifacts);
  return reduceShepherd(events);
}

function verifyEventEvidence(
  event: ShepherdEvent,
  artifacts: ContentAddressedArtifactStore,
): void {
  for (const evidence of evidenceFor(event)) {
    artifacts.verify(
      `artifact://sha256/${evidence.hash.slice("sha256:".length)}`,
      evidence.hash,
    );
  }
}

function evidenceFor(event: ShepherdEvent): HashedArtifactRef[] {
  switch (event.type) {
    case "evidence/attached":
      return [event.payload.evidence];
    case "claim/recorded":
    case "claim/verified":
    case "repair/verification-recorded":
    case "coverage/recorded":
      return event.payload.evidence;
    case "attempt/outcome-recorded":
      return event.payload.evidence ?? [];
    case "repair/intent-recorded":
      return [event.payload.manifest];
    case "repair/receipt-recorded":
    case "repair/rolled-back":
      return [event.payload.receipt];
    default:
      return [];
  }
}
