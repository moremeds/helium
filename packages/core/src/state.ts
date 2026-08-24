/**
 * Per-job sensor state (spec §8): baseline hash, dedup keys, and the rolling
 * budget fire stamps. Plain files under `<stateDir>/sensors/`.
 * @module @helium/core/state
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SensorState {
  /**
   * Trigger URL → the last fields/hash observed at that URL. Keyed per URL,
   * not per job: a job may carry several `state-change` triggers (the shipped
   * macro tenant watches both /api/rates/snapshot and /api/regime), and a
   * single shared slot makes each trigger compare its payload against a
   * DIFFERENT endpoint's fields — so every poll reports a change, fires on the
   * very first one, and hands the agent an unrelated `previous`. Observed live
   * on the mini during task 3.3; spec §8 requires the first poll after a cold
   * start to establish the baseline and never fire.
   */
  baselines: Record<string, { hash: string; fields: Record<string, unknown> }>;
  /** dedupKey → expiry ISO. */
  dedup: Record<string, string>;
  /** ISO stamps, pruned to the rolling budget window. */
  triageFires: string[];
  seniorFires: string[];
}

/** The state a job has before its first poll. */
export function emptySensorState(): SensorState {
  return { baselines: {}, dedup: {}, triageFires: [], seniorFires: [] };
}

/** Job names become file names, so they may not carry path syntax. */
function assertJobName(job: string): void {
  if (job === "" || /[/\\]/.test(job) || job === "." || job === "..") {
    throw new Error(`invalid job name ${JSON.stringify(job)}`);
  }
}

/** File-backed sensor state under one state root. */
export class StateStore {
  /** The harness state dir (HELIUM_STATE_ROOT). */
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(join(root, "sensors"), { recursive: true });
  }

  /** The file one job's state lives in. */
  private sensorPath(job: string): string {
    assertJobName(job);
    return join(this.root, "sensors", `${job}.json`);
  }

  /**
   * Read one job's state.
   * @param job - the job name.
   * @returns the persisted state, or an empty state when no file exists.
   */
  loadSensor(job: string): SensorState {
    let text: string;
    try {
      text = readFileSync(this.sensorPath(job), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return emptySensorState();
      throw error;
    }
    return { ...emptySensorState(), ...(JSON.parse(text) as SensorState) };
  }

  /**
   * Write one job's state atomically — a killed process never leaves a
   * half-written state file behind (spec §8).
   * @param job - the job name.
   * @param s - the state to persist.
   */
  saveSensor(job: string, s: SensorState): void {
    const target = this.sensorPath(job);
    const tmp = `${target}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(s, undefined, 2)}\n`);
    renameSync(tmp, target);
  }
}
