import { createHash } from "node:crypto";
import { canonicalJson } from "@helium/core";
import { z } from "zod";

const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const IdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const SymbolSchema = z.string().min(1).max(64);
const LayerSchema = z.enum(["raw", "bronze", "silver", "query"]);
const BarTimeframeSchema = z.enum(["1d", "1m", "5m", "30m", "1h"]);

export const HashedArtifactRefSchema = z.strictObject({
  ref: z.string().min(1).max(2_000),
  hash: Sha256Schema,
});
export type HashedArtifactRef = z.infer<typeof HashedArtifactRefSchema>;

const HashedArtifactRefsSchema = z.array(HashedArtifactRefSchema).min(1).superRefine(
  (refs, ctx) => {
    const seen = new Map<string, string>();
    for (const [index, candidate] of refs.entries()) {
      const prior = seen.get(candidate.ref);
      if (prior !== undefined && prior !== candidate.hash) {
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: `evidence hash conflict for ${candidate.ref}`,
        });
      }
      seen.set(candidate.ref, candidate.hash);
    }
  },
);

export const SecurityIntervalScopeSchema = z.strictObject({
  kind: z.literal("security-interval"),
  securityId: IdSchema,
  symbol: SymbolSchema,
  symbolValidFrom: z.iso.datetime(),
  symbolValidTo: z.iso.datetime().optional(),
  dateFrom: z.iso.date(),
  dateTo: z.iso.date(),
  timeframe: z.union([BarTimeframeSchema, z.enum(["corporate-action", "membership"])]),
  layer: LayerSchema,
}).superRefine((scope, ctx) => {
  if (
    scope.symbolValidTo !== undefined
    && Date.parse(scope.symbolValidTo) <= Date.parse(scope.symbolValidFrom)
  ) {
    ctx.addIssue({ code: "custom", path: ["symbolValidTo"], message: "symbol interval end must be after start" });
  }
  if (scope.dateTo < scope.dateFrom) {
    ctx.addIssue({ code: "custom", path: ["dateTo"], message: "date range end must not precede start" });
  }
});

export const CandidateIdentityScopeSchema = z.strictObject({
  kind: z.literal("candidate-identity"),
  candidateId: IdSchema,
  indexId: IdSchema,
  observedSymbol: SymbolSchema,
  sourceRevisionRefs: HashedArtifactRefsSchema,
});

export const IndexRevisionScopeSchema = z.strictObject({
  kind: z.literal("index-revision"),
  indexId: IdSchema,
  asOf: z.iso.datetime(),
  sourceRevisionRefs: HashedArtifactRefsSchema,
});

export const MarketPartitionScopeSchema = z.strictObject({
  kind: z.literal("market-partition"),
  provider: IdSchema,
  assetClass: IdSchema,
  marketDate: z.iso.date(),
  timeframe: BarTimeframeSchema,
  layer: LayerSchema,
});

export const ShepherdScopeSchema = z.union([
  SecurityIntervalScopeSchema,
  CandidateIdentityScopeSchema,
  IndexRevisionScopeSchema,
  MarketPartitionScopeSchema,
]);
export type ShepherdScope = z.infer<typeof ShepherdScopeSchema>;

export const SHEPHERD_STATES = [
  "DISCOVERED",
  "EVIDENCE_PENDING",
  "ADJUDICATING",
  "REPAIR_READY",
  "REPAIRING",
  "VERIFYING",
  "VERIFIED",
  "AWAITING_PROVIDER",
  "AWAITING_USER",
  "QUARANTINED",
  "ENGINEERING_ESCALATED",
  "UNRESOLVED",
  "RETRY_SCHEDULED",
] as const;
export const ShepherdStateSchema = z.enum(SHEPHERD_STATES);
export type ShepherdState = z.infer<typeof ShepherdStateSchema>;

export const ShepherdWorkUnitSchema = z.strictObject({
  version: z.literal(1),
  workUnitId: z.string().regex(/^lws-[0-9a-f]{32}$/),
  scope: ShepherdScopeSchema,
  revision: z.number().int().nonnegative(),
  scopeHash: Sha256Schema,
}).superRefine((unit, ctx) => {
  const expectedHash = scopeHashFor(unit.scope);
  if (unit.scopeHash !== expectedHash) {
    ctx.addIssue({ code: "custom", path: ["scopeHash"], message: "scope hash mismatch" });
  }
  if (unit.workUnitId !== workUnitIdFor(expectedHash)) {
    ctx.addIssue({ code: "custom", path: ["workUnitId"], message: "work-unit ID does not match scope" });
  }
});
export type ShepherdWorkUnit = z.infer<typeof ShepherdWorkUnitSchema>;

export function createWorkUnit(scope: ShepherdScope): ShepherdWorkUnit {
  const parsedScope = ShepherdScopeSchema.parse(scope);
  const scopeHash = scopeHashFor(parsedScope);
  return ShepherdWorkUnitSchema.parse({
    version: 1,
    workUnitId: workUnitIdFor(scopeHash),
    scope: parsedScope,
    revision: 0,
    scopeHash,
  });
}

export function scopeHashFor(scope: ShepherdScope): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(scope)).digest("hex")}`;
}

function workUnitIdFor(scopeHash: string): string {
  return `lws-${scopeHash.slice("sha256:".length, "sha256:".length + 32)}`;
}
