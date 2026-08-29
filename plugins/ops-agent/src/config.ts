/**
 * Bounded operations configuration.
 *
 * Every limit here exists because the loader reads files an operator edits by
 * hand. An unbounded loader turns a typo -- a stray directory, a runaway
 * generator -- into an unbounded startup, on the process that is supposed to
 * be the thing still working when everything else is not.
 * @module dsh-plugin-ops-agent/config
 */
import { z } from "zod";

export const OpsConfigSchema = z.strictObject({
  componentsDir: z.string().min(1),
  dependenciesDir: z.string().min(1),
  sopsDir: z.string().min(1),
  checksDir: z.string().min(1),
  authorityManifestPath: z.string().min(1),
  /** Path to the ONE trusted Ed25519 public key. */
  trustedKeyPath: z.string().min(1),
  maxFiles: z.number().int().positive().max(10_000).default(500),
  maxComponents: z.number().int().positive().max(10_000).default(200),
  maxSops: z.number().int().positive().max(10_000).default(200),
  maxChecks: z.number().int().positive().max(10_000).default(500),
  maxFileBytes: z.number().int().positive().max(10_000_000).default(1_000_000),
});
export type OpsConfig = z.infer<typeof OpsConfigSchema>;
