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

const manifest = parseYaml(
  readFileSync(at("docs/evidence/p0-manifest.yaml"), "utf8"),
) as {
  claims: {
    id: string;
    verification: {
      command: string;
      toolVersion: string;
      outputHash: string;
      decision: string;
    };
    status: string;
    artifacts: Artifact[];
  }[];
};

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

  it("contains exactly the P0 manifest's claims, and agrees with it field by field", () => {
    const registered = new Map(
      register.claims.filter((c) => c.phase === "P0").map((c) => [c.id, c]),
    );
    expect([...registered.keys()].sort()).toEqual(
      manifest.claims.map((c) => c.id).sort(),
    );
    for (const claim of manifest.claims) {
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
  });

  it("re-hashes every artifact a decided claim cites", () => {
    let checked = 0;
    for (const claim of register.claims) {
      if (claim.status === "PLANNED") continue;
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
      if (claim.status === "PLANNED") continue;
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

  it("gives a PLANNED claim a gate that will decide it, and no hash", () => {
    for (const claim of register.claims) {
      if (claim.status !== "PLANNED") continue;
      expect(claim.nextGate, `${claim.id}`).toBeTruthy();
      expect(claim.outputHash, `${claim.id} records a hash it cannot have`).toBeUndefined();
    }
  });
});
