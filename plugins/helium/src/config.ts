import { join } from "node:path";
import { z } from "zod";

export interface Config {
  teamPromotionMode?: "off" | "shadow" | "review-only" | "delivered";
  teamCanaryTenants?: string[];
  teamCanaryMaxPerUtcDay?: number;
  teamsDir?: string;
  tenantsDir: string;
  tenantDeliveryEnabled?: boolean;
  /**
   * Liveness heartbeat period. The dead-man's stale window
   * (`HELIUM_DEADMAN_STALE_S`, 600 s) is tunable, so the emitter period has to
   * be too, or the two can be configured into permanent disagreement.
   */
  tenantLivenessMs?: number;
  stateRoot: string;
  contextFile: string;
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
  teamPromotionMode: z
    .enum(["off", "shadow", "review-only", "delivered"])
    .default("off"),
  teamCanaryTenants: z.array(z.string().min(1)).default([]),
  teamCanaryMaxPerUtcDay: z.number().int().positive().default(1),
  teamsDir: z.string().min(1).default("teams"),
  tenantsDir: z.string().min(1),
  tenantDeliveryEnabled: z.boolean().default(false),
  tenantLivenessMs: z.number().int().positive().max(3_600_000).default(300_000),
  stateRoot: z.string().min(1),
  contextFile: z.string().min(1),
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
