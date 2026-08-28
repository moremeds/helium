import { join } from "node:path";
import { z } from "zod";

export interface Config {
  jobsDir: string;
  stateRoot: string;
  contextFile: string;
  calendarsDir: string;
  argonBase: string;
  apexBase: string;
  livewireDb?: string;
  envFile: string;
  claudeTokenFile: string;
  proxy: string;
  mcpBin: string;
  emailTo: string;
}

export const ConfigSchema = z.object({
  jobsDir: z.string().min(1),
  stateRoot: z.string().min(1),
  contextFile: z.string().min(1),
  calendarsDir: z.string().min(1),
  argonBase: z.string().min(1),
  apexBase: z.string().min(1),
  livewireDb: z.string().min(1).optional(),
  envFile: z.string().min(1),
  claudeTokenFile: z.string().min(1),
  proxy: z.string().min(1),
  mcpBin: z.string().min(1),
  emailTo: z.string().min(1),
}) satisfies z.ZodType<Config>;

export interface StatePaths {
  state: string;
  sensors: string;
  jsonl: string;
  reports: string;
  theses: string;
  /** Parent of the per-attempt senior workspaces; never `process.cwd()`. */
  workspaces: string;
}

/** HELIUM_STATE_ROOT points directly at the harness state dir (e.g. ~/.helium/state). */
export function statePaths(cfg: Config): StatePaths {
  const state = cfg.stateRoot;
  return {
    state,
    sensors: join(state, "sensors"),
    jsonl: join(state, "jsonl"),
    reports: join(state, "reports"),
    theses: join(state, "theses"),
    workspaces: join(state, "workspaces"),
  };
}
