/**
 * `EvidenceManifest` — the phase/release index over one or more claims.
 *
 * Its field set is the frozen `p0-1` template's field set, recorded in the
 * multi-agent master plan. P1 inherits that template: every field survives
 * with the same meaning, P1 may only ADD fields or TIGHTEN types, and the
 * hand-written P0 manifest must validate here without being rewritten. That
 * round trip is asserted in this module's test and is the only thing that
 * keeps "inherits" from decaying into "resembles".
 * @module @helium/core/evidence/manifest
 */
import { z } from "zod";
import { EVIDENCE_STATUSES, VERIFIER_DECISIONS } from "./bundle.js";

export const MANIFEST_SCOPES = ["production", "shadow", "drill", "offline"] as const;
export type ManifestScope = (typeof MANIFEST_SCOPES)[number];

export const ASSERTION_CLASSES = ["deterministic", "statistical"] as const;
export type AssertionClass = (typeof ASSERTION_CLASSES)[number];

/**
 * Every field the frozen template names on a claim. Exported so the rejection
 * tests are driven from this list rather than from a shorter one of their own
 * -- review finding XDOC-12, where an 8-field test silently narrowed an
 * 11-row requirement.
 */
export const P0_CLAIM_FIELDS = [
  "id",
  "assertion",
  "acceptanceBound",
  "assertionClass",
  "evidencePolicyVersion",
  "verification",
  "artifacts",
  "baseline",
  "reproduction",
  "failures",
  "status",
  "limitation",
  "nextGate",
] as const;

/** Additionally required when the assertion class is `statistical`. */
export const P0_STATISTICAL_CLAIM_FIELDS = [
  "sampleCount",
  "latencyMs",
  "cost",
  "confidence",
] as const;

/**
 * The verifier of a deterministic assertion is a COMMAND plus its exact
 * version plus the hash of its output. Never a model, and never a second
 * human who does not exist -- this is a single-operator project, so a manifest
 * implying independent human review is a false evidence record. `verifier` is
 * therefore a literal, not an open string.
 */
export const VerificationSchema = z.strictObject({
  verifier: z.literal("command"),
  command: z.string().min(1),
  toolVersion: z.string().min(1),
  /**
   * Required for any status that implies a run; absent for `PLANNED` and
   * `BLOCKED`, which have no output to hash. See the claim-level refinement.
   */
  outputHash: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
  decision: z.enum(VERIFIER_DECISIONS),
});

export const ManifestArtifactSchema = z.strictObject({
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const ClaimShape = z.strictObject({
  id: z.string().min(1),
  assertion: z.string().min(1),
  acceptanceBound: z.string().min(1),
  assertionClass: z.enum(ASSERTION_CLASSES),
  evidencePolicyVersion: z.string().min(1),
  verification: VerificationSchema,
  artifacts: z.array(ManifestArtifactSchema),
  baseline: z.string().min(1),
  reproduction: z.string().min(1),
  failures: z.string().min(1),
  status: z.enum(EVIDENCE_STATUSES),
  limitation: z.string().min(1),
  nextGate: z.string().min(1),
  sampleCount: z.number().int().nonnegative().optional(),
  latencyMs: z.number().nonnegative().optional(),
  cost: z.number().nonnegative().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

/** Statuses that assert something was actually run and observed. */
const DECIDED_STATUSES = new Set(["PROVEN", "PARTIAL", "FAILED"]);

export const ManifestClaimSchema = ClaimShape.superRefine((claim, ctx) => {
  // A decided claim owes an output hash and at least one artifact. A PLANNED
  // or BLOCKED claim owes neither: nothing ran, so there is nothing to hash,
  // and inventing a value to satisfy a schema is exactly the fabrication the
  // evidence record exists to prevent.
  if (DECIDED_STATUSES.has(claim.status)) {
    if (claim.verification.outputHash === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["verification", "outputHash"],
        message: `status ${claim.status} requires an output hash`,
      });
    }
    if (claim.artifacts.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["artifacts"],
        message: `status ${claim.status} requires at least one artifact`,
      });
    }
  } else if (claim.verification.outputHash !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["verification", "outputHash"],
      message: `status ${claim.status} records a hash for a run that did not happen`,
    });
  }

  if (claim.assertionClass !== "statistical") return;
  for (const field of P0_STATISTICAL_CLAIM_FIELDS) {
    if (claim[field] === undefined) {
      ctx.addIssue({
        code: "custom",
        path: [field],
        message: `a statistical assertion must record ${field}`,
      });
    }
  }
});
export type ManifestClaim = z.infer<typeof ClaimShape>;

export const EvidenceManifestSchema = z.strictObject({
  manifestVersion: z.string().min(1),
  phase: z.string().min(1),
  scope: z.enum(MANIFEST_SCOPES),
  recordedAt: z.string().min(1),
  claims: z.array(ManifestClaimSchema).min(1),
});
export type EvidenceManifest = z.infer<typeof EvidenceManifestSchema>;
