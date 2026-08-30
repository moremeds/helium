/** Reads the existing opsd memory-pressure stream; it is not a second probe. */
import { readFileSync } from "node:fs";
import type { ObservationState, ResourcePressure } from "@helium/core";

interface MemoryRow {
  state: ObservationState;
  observedAt: string;
  expiresAt: string;
}

const STATES = new Set<ObservationState>(["ok", "degraded", "failed", "unknown"]);

/**
 * The ops collector deliberately calls any allocated swap `degraded` for
 * capacity planning. Admission needs current headroom instead: a review-only,
 * serial canary is safe when the same observation proves normal pressure,
 * at least 25% free memory, low pageout churn, and no service impact. The Ops
 * event itself remains degraded and visible; only this admission projection is
 * normalized.
 */
function admissionState(observation: Record<string, unknown>): ObservationState {
  const state = observation.state as ObservationState;
  if (state !== "degraded") return state;
  const value = observation.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return state;
  const sample = value as Record<string, unknown>;
  const pressure = sample.pressure;
  if (typeof pressure !== "object" || pressure === null || Array.isArray(pressure)) {
    return state;
  }
  const memory = pressure as Record<string, unknown>;
  return memory.level === "normal"
    && typeof memory.freePercent === "number"
    && memory.freePercent >= 25
    && typeof sample.pageoutRate === "number"
    && Number.isFinite(sample.pageoutRate)
    && sample.pageoutRate < 100
    && sample.serviceImpact === false
    ? "ok"
    : state;
}

function decode(line: string): MemoryRow | undefined {
  try {
    const envelope = JSON.parse(line) as {
      record?: {
        type?: unknown;
        observation?: Record<string, unknown>;
      };
    };
    const record = envelope.record;
    const observation = record?.observation;
    if (
      record?.type !== "observation-recorded"
      || observation?.componentId !== "host"
      || observation.dimension !== "memory-pressure"
      || !STATES.has(observation.state as ObservationState)
      || typeof observation.observedAt !== "string"
      || typeof observation.expiresAt !== "string"
      || Number.isNaN(Date.parse(observation.observedAt))
      || Number.isNaN(Date.parse(observation.expiresAt))
    ) {
      return undefined;
    }
    return {
      state: admissionState(observation),
      observedAt: observation.observedAt,
      expiresAt: observation.expiresAt,
    };
  } catch {
    return undefined;
  }
}

export class OpsResourcePressureReader {
  readonly #read: () => string;
  readonly #now: () => Date;

  constructor(
    path: string,
    options: { read?: () => string; now?: () => Date } = {},
  ) {
    this.#read = options.read ?? (() => readFileSync(path, "utf8"));
    this.#now = options.now ?? (() => new Date());
  }

  read(): ResourcePressure {
    let text: string;
    try {
      text = this.#read();
    } catch {
      return { memoryState: "unknown", observedForMs: 0 };
    }
    const nowMs = this.#now().getTime();
    const rows = text
      .split("\n")
      .flatMap((line) => {
        const row = decode(line);
        return row === undefined ? [] : [row];
      })
      .filter((row) => Date.parse(row.observedAt) <= nowMs)
      .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
    const latest = rows.at(-1);
    if (latest === undefined || Date.parse(latest.expiresAt) < nowMs) {
      return { memoryState: "unknown", observedForMs: 0 };
    }
    let first = rows.length - 1;
    while (first > 0 && rows[first - 1]!.state === latest.state) first -= 1;
    const observedForMs = Math.max(0, nowMs - Date.parse(rows[first]!.observedAt));
    const prior = rows[first - 1];
    const recoveringFromPressure =
      latest.state === "ok"
      && (prior?.state === "degraded" || prior?.state === "failed");
    return {
      memoryState: latest.state,
      observedForMs,
      ...(recoveringFromPressure
        ? { recoveringFromPressure: true, recoveredForMs: observedForMs }
        : {}),
    };
  }
}
