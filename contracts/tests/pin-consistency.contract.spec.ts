/**
 * The dsh pin is written by hand into nine places. Nothing used to compare them.
 *
 * The 0.1.2-alpha.3 promotion left `DSH_PIN` in scripts/release/deploy.sh on the
 * previous version while build, typecheck, unit and contracts were all green —
 * so the mini would have installed the old dsh from a fully passing tree. It was
 * caught by grep, which is not a gate. This is the gate.
 *
 * @module @helium/contracts/tests/pin-consistency
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PINNED_DSH_VERSION, repoRoot } from "../src/dsh.js";

/** Packages whose versions move on dsh's numbering. cordis has its own. */
const DSH_SCOPE = /^@deepseek-ai\/dsh(-|$)/;

function pinsIn(relPath: string): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(repoRoot, relPath), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return Object.fromEntries(
    Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })
      .filter(([name]) => DSH_SCOPE.test(name))
      .map(([name, range]) => [`${relPath}:${name}`, range]),
  );
}

const MANIFESTS = [
  "package.json",
  "profile/package.json",
  "plugins/helium/package.json",
  "contracts/fixtures/plugin-live-dispatch/package.json",
  "contracts/fixtures/plugin-restrict-proof/package.json",
  "contracts/fixtures/team-host/package.json",
];

describe("contract: dsh pin agrees across every site that declares it", () => {
  it("pins every @deepseek-ai/dsh* dependency to the contract's version", () => {
    const declared = Object.assign({}, ...MANIFESTS.map(pinsIn)) as Record<
      string,
      string
    >;
    // A zero-row check would pass vacuously if the scope regex ever stopped
    // matching, which is the same failure it exists to catch.
    expect(Object.keys(declared).length).toBeGreaterThan(10);
    const wrong = Object.entries(declared).filter(
      ([, range]) => range !== PINNED_DSH_VERSION,
    );
    expect(wrong).toEqual([]);
  });

  it("keeps scripts/release/deploy.sh's DSH_PIN on the same version", () => {
    // deploy.sh is what actually installs dsh onto the mini. No other test
    // reads it, so a stale value here ships the wrong runtime from a green tree.
    const deploy = readFileSync(
      join(repoRoot, "scripts", "release", "deploy.sh"),
      "utf8",
    );
    const match = /^DSH_PIN=(.+)$/m.exec(deploy);
    expect(match, "deploy.sh no longer declares DSH_PIN").not.toBeNull();
    expect(match?.[1]).toBe(PINNED_DSH_VERSION);
  });
});
