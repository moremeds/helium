/**
 * The closed claims register is checkable, and every claim in it is bounded.
 *
 * An open claim set has no denominator: nothing in it can be found missing, so
 * "all claims are proven" is unfalsifiable. This contract keeps the register
 * honest against the artifacts it cites and against the P0 manifest it copies.
 *
 * On why this does not re-run each claim's command and compare output hashes,
 * see the header of `docs/evidence/claims.yaml`. In short: an output hash is
 * not reproducible (the captured output carries wall-clock durations), and two
 * of the recorded commands are `pnpm run test:contracts`, which is the suite
 * this file runs in.
 * @module contracts/claims-register
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const at = (rel: string) => `${repoRoot}${rel}`;

interface Artifact {
  path: string;
  sha256: string;
}
interface Claim {
  id: string;
  phase: string;
  assertion: string;
  assertionClass: string;
  command?: string;
  toolVersion?: string;
  outputHash?: string;
  decision?: string;
  artifacts?: Artifact[];
  status: string;
  limitation?: string;
  nextGate: string;
}

const register = parseYaml(
  readFileSync(at("docs/evidence/claims.yaml"), "utf8"),
) as { registerVersion: number; claims: Claim[] };

interface ManifestClaim {
  id: string;
  verification: {
    command: string;
    toolVersion: string;
    outputHash: string;
    decision: string;
  };
  status: string;
  artifacts: Artifact[];
}

/**
 * Every phase manifest, by the phase whose rows it owns in the register. A
 * phase that lands a manifest and forgets to add it here would have its rows
 * go uncross-checked, so the count is asserted below.
 */
const MANIFESTS: Record<string, string> = {
  P0: "docs/evidence/p0-manifest.yaml",
  P1: "docs/evidence/p1-manifest.yaml",
  "P2.5a": "docs/evidence/p2.5a-manifest.yaml",
};

/** Statuses that assert something actually ran. The rest owe no hash. */
const UNDECIDED = new Set(["PLANNED", "BLOCKED"]);

const manifests = Object.fromEntries(
  Object.entries(MANIFESTS).map(([phase, path]) => [
    phase,
    (parseYaml(readFileSync(at(path), "utf8")) as { claims: ManifestClaim[] })
      .claims,
  ]),
);

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("closed claims register", () => {
  it("is parseable and non-empty — zero rows is a failure, not a vacuous pass", () => {
    expect(register.registerVersion).toBe(1);
    expect(Array.isArray(register.claims)).toBe(true);
    expect(register.claims.length).toBeGreaterThan(0);
  });

  it("gives every claim a unique id", () => {
    const ids = register.claims.map((c) => c.id);
    expect(ids).toEqual([...new Set(ids)]);
  });

  it("covers every phase that has landed a manifest", () => {
    // A phase whose manifest is not listed would have its rows silently
    // uncross-checked. Assert the composition rather than trusting the loop.
    expect(Object.keys(MANIFESTS).sort()).toEqual(["P0", "P1", "P2.5a"]);
    const phases = [...new Set(register.claims.map((c) => c.phase))].sort();
    expect(phases).toEqual(["P0", "P1", "P2.5a"]);
  });

  it.each(Object.keys(MANIFESTS))(
    "contains exactly the %s manifest's claims, and agrees with it field by field",
    (phase) => {
    const claims = manifests[phase];
    const registered = new Map(
      register.claims.filter((c) => c.phase === phase).map((c) => [c.id, c]),
    );
    expect([...registered.keys()].sort()).toEqual(
      claims.map((c) => c.id).sort(),
    );
    for (const claim of claims) {
      const row = registered.get(claim.id);
      expect(row, `${claim.id} is missing from the register`).toBeDefined();
      expect({
        command: row?.command,
        toolVersion: row?.toolVersion,
        outputHash: row?.outputHash,
        decision: row?.decision,
        status: row?.status,
      }).toEqual({
        command: claim.verification.command,
        toolVersion: claim.verification.toolVersion,
        outputHash: claim.verification.outputHash,
        decision: claim.verification.decision,
        status: claim.status,
      });
    }
  },
  );

  it("re-hashes every artifact a decided claim cites", () => {
    let checked = 0;
    for (const claim of register.claims) {
      if (UNDECIDED.has(claim.status)) continue;
      expect(claim.artifacts?.length, `${claim.id} cites no artifact`).toBeGreaterThan(0);
      for (const artifact of claim.artifacts ?? []) {
        const path = at(artifact.path);
        expect(existsSync(path), `${claim.id}: missing ${artifact.path}`).toBe(true);
        expect(sha256(readFileSync(path)), `${claim.id}: ${artifact.path}`).toBe(
          artifact.sha256,
        );
        checked += 1;
      }
    }
    // A loop that checked nothing would pass silently.
    expect(checked).toBeGreaterThan(0);
  });

  it("keeps every decided claim's output hash consistent with its artifacts", () => {
    for (const claim of register.claims) {
      if (UNDECIDED.has(claim.status)) continue;
      const joined = Buffer.concat(
        (claim.artifacts ?? []).map((a) => readFileSync(at(a.path))),
      );
      expect(claim.outputHash, `${claim.id}`).toBe(`sha256:${sha256(joined)}`);
    }
  });

  it("refuses a PROVEN claim whose verifier did not pass", () => {
    for (const claim of register.claims) {
      if (claim.status !== "PROVEN") continue;
      expect(claim.decision, `${claim.id}`).toBe("pass");
      expect(claim.command, `${claim.id} names no verifying command`).toBeTruthy();
      expect(claim.toolVersion, `${claim.id} pins no tool version`).toBeTruthy();
    }
  });

  it("requires a PARTIAL claim to name the proof it is missing", () => {
    const partial = register.claims.filter((c) => c.status === "PARTIAL");
    expect(partial.length).toBeGreaterThan(0);
    for (const claim of partial) {
      expect(claim.limitation?.trim(), `${claim.id}`).toBeTruthy();
    }
  });

  it("gives an undecided claim a gate that will decide it, and no hash", () => {
    const undecided = register.claims.filter((c) => UNDECIDED.has(c.status));
    expect(undecided.length).toBeGreaterThan(0);
    for (const claim of undecided) {
      expect(claim.nextGate, `${claim.id}`).toBeTruthy();
      expect(claim.outputHash, `${claim.id} records a hash it cannot have`).toBeUndefined();
      expect(claim.limitation, `${claim.id} does not say what is unproven`).toBeTruthy();
    }
  });
});
