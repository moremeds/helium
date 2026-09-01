/**
 * The dsh installation under contract. The canary (spec §10) reruns this same
 * suite against a candidate version by setting HELIUM_DSH_VERSION and
 * HELIUM_DSH_BIN at an isolated install; everything else defaults to the pin.
 * @module @helium/contracts/dsh
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
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

/** A throwaway `$DSH_HOME` — never the operator's default `~/.dsh` (spec §9.4). */
export function makeDshHome(): string {
  return mkdtempSync(join(tmpdir(), "helium-dsh-home-"));
}

/** Install the helium profile into a throwaway home through the real deploy script. */
export function deployHeliumProfile(dshHome: string): void {
  execFileSync(
    join(repoRoot, "scripts", "deploy-profile.sh"),
    ["--dsh-home", dshHome],
    {
      cwd: repoRoot,
      stdio: "pipe",
      encoding: "utf8",
    },
  );
}
