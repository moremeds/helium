/**
 * The dsh installation under contract. The canary (spec §10) reruns this same
 * suite against a candidate version by setting HELIUM_DSH_VERSION and
 * HELIUM_DSH_BIN at an isolated install; everything else defaults to the pin.
 * @module @helium/contracts/dsh
 */
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The dsh version helium pins (plan global constraint; spec §9.1). */
export const PINNED_DSH_VERSION = "0.1.2-alpha.3";

/** The dsh version this run exercises. */
export const dshVersion: string =
  process.env.HELIUM_DSH_VERSION ?? PINNED_DSH_VERSION;

/** Repository root — contracts/src → contracts → repo. */
export const repoRoot: string = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** The dsh binary this run drives. */
export const dshBin: string =
  process.env.HELIUM_DSH_BIN ?? join(repoRoot, "node_modules", ".bin", "dsh");

/**
 * `overrides:` lines pinning every `@deepseek-ai/*` package to `dshVersion`.
 *
 * The dsh train versions in lockstep but depends on itself through CARET
 * ranges (`@deepseek-ai/dsh-base@0.1.2-alpha.3` asks for
 * `"@deepseek-ai/dsh-agent": "^0.1.2-alpha.3"`). The repo's own lockfile holds
 * that float still; an install into a generated fixture or profile directory
 * has no lockfile and re-resolves from the registry every time it runs.
 *
 * On 2026-09-02 that turned a green suite red with no commit in between:
 * `dsh-subagent` published `0.1.2-alpha.5`, the profile floated to it, and
 * `dsh-tool-subagent-report` — still on alpha.3 — called a
 * `ctx.subagents.registerContinuableSetup` that no longer existed. The last
 * GREEN master failed identically when re-run. A contract test whose verdict
 * depends on the date is not a contract, so both installs are pinned here.
 *
 * The names come from the repo's own store rather than a hand-kept list, so a
 * version bump moves one constant and nothing else.
 */
export function dshOverrides(): Record<string, string> {
  const suffix = `@${dshVersion}`;
  const pins: Record<string, string> = {};
  for (const entry of readdirSync(join(repoRoot, "node_modules", ".pnpm"))) {
    // "@deepseek-ai+dsh-base@0.1.2-alpha.3_<peer hash>" -> "@deepseek-ai/dsh-base"
    const at = entry.indexOf(suffix);
    if (at <= 0 || !entry.startsWith("@deepseek-ai+")) continue;
    pins[entry.slice(0, at).replace("+", "/")] = dshVersion;
  }
  return pins;
}

/** Those pins as the body of a `pnpm-workspace.yaml` `overrides:` block. */
export function dshOverridesYaml(): string[] {
  return [
    "overrides:",
    ...Object.entries(dshOverrides())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, version]) => `  '${name}': ${version}`),
  ];
}

/** A throwaway `$DSH_HOME` — never the operator's default `~/.dsh` (spec §9.4). */
export function makeDshHome(): string {
  return mkdtempSync(join(tmpdir(), "helium-dsh-home-"));
}
