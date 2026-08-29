import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  EvidenceManifestSchema,
  P0_CLAIM_FIELDS,
  P0_STATISTICAL_CLAIM_FIELDS,
} from "../src/evidence/manifest.js";

const claim = {
  id: "P0-ISOLATION-UNDECLARED-TOOL",
  assertion: "An execution target cannot invoke a tool outside its declared contract.",
  acceptanceBound: "Zero undeclared tool invocations across the adversarial suite.",
  assertionClass: "deterministic",
  evidencePolicyVersion: "p0-1",
  verification: {
    verifier: "command",
    command: "pnpm run test:contracts",
    toolVersion: "node 22.19.0; pnpm 11.24.0; vitest 3.2.7",
    outputHash: `sha256:${"0".repeat(64)}`,
    decision: "pass",
  },
  artifacts: [{ path: "docs/evidence/p0/test-contracts.log", sha256: "0".repeat(64) }],
  baseline: "v1 behavior at 72a48265b44ed0de7d204bd82cc766aedbaf81d8",
  reproduction: "git checkout <commit> && pnpm install && pnpm run test:contracts",
  failures: "None observed.",
  status: "PROVEN",
  limitation: "Proves the contract suite, not production behaviour.",
  nextGate: "Phase 1 exit.",
};

const manifest = {
  manifestVersion: "p0-1",
  phase: "P0",
  scope: "offline",
  recordedAt: "2026-08-29T03:05:00Z",
  claims: [claim],
};

describe("EvidenceManifestSchema", () => {
  it("parses a manifest built on the frozen p0-1 template", () => {
    expect(EvidenceManifestSchema.parse(manifest).claims).toHaveLength(1);
  });

  // Review finding XDOC-12: an 8-field test silently narrowed the master
  // plan's 11-row requirement. Drive the rejection cases from the template's
  // own field list so the schema and the test cannot drift apart.
  it("rejects a claim missing any field the frozen template names", () => {
    expect(P0_CLAIM_FIELDS.length).toBeGreaterThanOrEqual(13);
    for (const field of P0_CLAIM_FIELDS) {
      const { [field]: _dropped, ...rest } = claim as Record<string, unknown>;
      expect(
        () => EvidenceManifestSchema.parse({ ...manifest, claims: [rest] }),
        `dropping ${field} must be rejected`,
      ).toThrow();
    }
  });

  it("requires the statistical fields only when the assertion class is statistical", () => {
    expect(P0_STATISTICAL_CLAIM_FIELDS).toEqual([
      "sampleCount",
      "latencyMs",
      "cost",
      "confidence",
    ]);
    expect(() =>
      EvidenceManifestSchema.parse({
        ...manifest,
        claims: [{ ...claim, assertionClass: "statistical" }],
      }),
    ).toThrow();
    expect(
      EvidenceManifestSchema.parse({
        ...manifest,
        claims: [
          {
            ...claim,
            assertionClass: "statistical",
            sampleCount: 30,
            latencyMs: 1200,
            cost: 0.4,
            confidence: 0.95,
          },
        ],
      }).claims[0].assertionClass,
    ).toBe("statistical");
  });

  // A claim that never ran has no output to hash. Requiring one would force a
  // fabricated value, which is the opposite of what the record is for.
  it("requires an output hash for a decided claim and refuses one for an undecided claim", () => {
    for (const status of ["PROVEN", "PARTIAL", "FAILED"]) {
      const { outputHash: _drop, ...verification } = claim.verification;
      expect(() =>
        EvidenceManifestSchema.parse({
          ...manifest,
          claims: [{ ...claim, status, verification }],
        }),
      ).toThrow(/requires an output hash/);
    }
    for (const status of ["PLANNED", "BLOCKED"]) {
      expect(() =>
        EvidenceManifestSchema.parse({
          ...manifest,
          claims: [{ ...claim, status }],
        }),
      ).toThrow(/a run that did not happen/);
      expect(() => {
        const { outputHash: _drop, ...verification } = claim.verification;
        EvidenceManifestSchema.parse({
          ...manifest,
          claims: [{ ...claim, status, verification, artifacts: [] }],
        });
      }).not.toThrow();
    }
  });

  it("admits only the canonical status and scope vocabularies", () => {
    expect(() =>
      EvidenceManifestSchema.parse({ ...manifest, claims: [{ ...claim, status: "VERIFIED" }] }),
    ).toThrow();
    expect(() =>
      EvidenceManifestSchema.parse({ ...manifest, scope: "somewhere" }),
    ).toThrow();
  });

  it("refuses a verifier that is not a command", () => {
    // The verifier of a deterministic assertion is a command plus its exact
    // version plus the hash of its output -- never a model, and never a second
    // human who does not exist.
    expect(() =>
      EvidenceManifestSchema.parse({
        ...manifest,
        claims: [
          { ...claim, verification: { ...claim.verification, verifier: "model" } },
        ],
      }),
    ).toThrow();
  });

  // P1 inherits the frozen template: every field survives with the same
  // meaning, P1 may only add fields or tighten types, and the hand-written P0
  // manifest must validate against this schema WITHOUT being rewritten.
  it.each([
    ["p0-manifest.yaml", 7, 2],
    ["p1-manifest.yaml", 6, 2],
    ["p2.5a-manifest.yaml", 13, 1],
  ])("validates the committed %s unchanged", (file, claims, partial) => {
    const path = fileURLToPath(
      new URL(`../../../docs/evidence/${file}`, import.meta.url),
    );
    const parsed = EvidenceManifestSchema.parse(
      parseYaml(readFileSync(path, "utf8")),
    );
    expect(parsed.manifestVersion).toBe("p0-1");
    expect(parsed.claims).toHaveLength(claims);
    expect(parsed.claims.filter((c) => c.status === "PARTIAL")).toHaveLength(
      partial,
    );
  });
});
