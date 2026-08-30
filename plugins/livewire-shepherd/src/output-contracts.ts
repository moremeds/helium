import { z } from "zod";
import {
  ClaimSchema,
  ClaimSetSchema,
  EvidenceBundleSchema,
} from "@helium/core";
import {
  OutputContractRegistry,
  type ClaimOutput,
  type OutputContractContext,
} from "dsh-plugin-helium/output-contract-registry";

const Sha256Schema = z.string().regex(/^(?:sha256:)?[0-9a-f]{64}$/);
const SourceAuthoritySchema = z.enum([
  "responsible-publisher",
  "regulator",
  "provider",
  "secondary",
  "discovery",
]);

const ShepherdClaimSchema = ClaimSchema.extend({
  material: z.boolean(),
  eventTime: z.iso.datetime().optional(),
  publicationTime: z.iso.datetime().optional(),
  retrievalTime: z.iso.datetime().optional(),
  revisionTime: z.iso.datetime().optional(),
  sourceAuthority: SourceAuthoritySchema.optional(),
}).superRefine((claim, ctx) => {
  if (claim.kind !== "fact" && !claim.material) return;
  if (claim.asOf === undefined) {
    ctx.addIssue({ code: "custom", path: ["asOf"], message: "material Shepherd claim requires asOf" });
  }
  for (const field of [
    "eventTime",
    "publicationTime",
    "retrievalTime",
    "revisionTime",
    "sourceAuthority",
  ] as const) {
    if (claim[field] === undefined) {
      ctx.addIssue({ code: "custom", path: [field], message: `Shepherd fact requires ${field}` });
    }
  }
  if (claim.asOf === undefined || claim.publicationTime === undefined) return;
  if (Date.parse(claim.publicationTime) > Date.parse(claim.asOf)) {
    ctx.addIssue({ code: "custom", path: ["publicationTime"], message: "publicationTime exceeds asOf" });
  }
  if (claim.eventTime !== undefined && Date.parse(claim.eventTime) > Date.parse(claim.asOf)) {
    ctx.addIssue({ code: "custom", path: ["eventTime"], message: "eventTime exceeds asOf" });
  }
  if (
    claim.revisionTime !== undefined &&
    claim.retrievalTime !== undefined &&
    Date.parse(claim.revisionTime) > Date.parse(claim.retrievalTime)
  ) {
    ctx.addIssue({ code: "custom", path: ["revisionTime"], message: "revisionTime exceeds retrievalTime" });
  }
  if (claim.kind === "fact" && claim.sourceAuthority === "discovery") {
    ctx.addIssue({ code: "custom", path: ["sourceAuthority"], message: "discovery evidence cannot prove a fact" });
  }
});

export const ShepherdClaimSetSchema = z.strictObject({
  scopeHash: Sha256Schema,
  claimSet: z.strictObject({
    claimSetId: z.string().min(1),
    producerRole: z.string().min(1),
    claims: z.array(ShepherdClaimSchema),
  }).superRefine((value, ctx) => {
    const keys = value.claims.map((claim) => claim.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: "custom", message: "claim keys must be unique within a claim set" });
    }
  }),
  evidence: z.array(EvidenceBundleSchema),
});

export type ShepherdClaimSet = z.infer<typeof ShepherdClaimSetSchema>;

export const ShepherdRepairProposalSchema = z.strictObject({
  workUnitId: z.string().min(1),
  scopeHash: Sha256Schema,
  eligibleOperation: z.string().min(1),
  acceptedClaimKeys: z.array(z.string().min(1)).min(1),
  sourceEvidence: z.array(z.strictObject({
    ref: z.string().min(1),
    hash: Sha256Schema,
  })).min(1),
  maxRows: z.number().int().nonnegative(),
  maxBytes: z.number().int().nonnegative(),
  expiresAt: z.iso.datetime(),
});

export type ShepherdRepairProposal = z.infer<typeof ShepherdRepairProposalSchema>;

function baseClaimSet(value: ShepherdClaimSet): ClaimOutput {
  return {
    claimSet: ClaimSetSchema.parse({
      ...value.claimSet,
      claims: value.claimSet.claims.map((claim) => ({
        key: claim.key,
        statement: claim.statement,
        kind: claim.kind,
        evidenceRefs: claim.evidenceRefs,
        confidence: claim.confidence,
        assumptions: claim.assumptions,
        ...(claim.asOf === undefined ? {} : { asOf: claim.asOf }),
      })),
    }),
    evidence: value.evidence,
  };
}

function validateScope(scopeHash: string, context: OutputContractContext): void {
  const expected = context.contract?.scopeHash;
  if (expected !== undefined && scopeHash !== expected) {
    throw new Error(`output scope hash ${scopeHash} does not match ${expected}`);
  }
}

function shepherdClaimPrompt(context: Pick<OutputContractContext, "role" | "evidenceRefs" | "contract">): string {
  return [
    "Return exactly one JSON object with no markdown fence or commentary.",
    "Schema: {scopeHash,claimSet:{claimSetId,producerRole,claims:[{key,statement,kind,evidenceRefs,confidence,assumptions,asOf,material,eventTime,publicationTime,retrievalTime,revisionTime,sourceAuthority}]},evidence:[EvidenceBundle.v1]}.",
    `producerRole must be ${JSON.stringify(context.role)} and scopeHash must be ${JSON.stringify(context.contract?.scopeHash ?? "the supplied scope hash")}.`,
    `Every evidenceRefs entry must be chosen from: ${JSON.stringify(context.evidenceRefs)} and bound to a SHA-256 in its EvidenceBundle.`,
    "Every factual claim requires event, publication, retrieval, and revision clocks plus source authority. Publication and event time must not exceed asOf; revision time must not exceed retrieval time. Search snippets are discovery only and cannot prove a fact.",
  ].join("\n");
}

export function registerShepherdOutputContracts(registry: OutputContractRegistry): OutputContractRegistry {
  registry.register("ShepherdClaimSet.v1", {
    prompt: shepherdClaimPrompt,
    validate: (structured, context) => {
      const parsed = ShepherdClaimSetSchema.parse(structured);
      validateScope(parsed.scopeHash, context);
      const base = baseClaimSet(parsed);
      registry.validate("ClaimSet.v1", base, context);
      return parsed;
    },
    extractClaims: (structured, context) => {
      const parsed = ShepherdClaimSetSchema.safeParse(structured);
      if (!parsed.success) return undefined;
      if (context !== undefined) validateScope(parsed.data.scopeHash, context);
      return baseClaimSet(parsed.data);
    },
  });

  registry.register("ShepherdRepairProposal.v1", {
    prompt: ({ contract }) => [
      "Return exactly one JSON object with no markdown fence or commentary.",
      "Schema: {workUnitId,scopeHash,eligibleOperation,acceptedClaimKeys,sourceEvidence:[{ref,hash}],maxRows,maxBytes,expiresAt}.",
      `scopeHash must be ${JSON.stringify(contract?.scopeHash ?? "the supplied scope hash")}.`,
      `eligibleOperation must be chosen from ${JSON.stringify(contract?.eligibleOperations ?? [])}.`,
      "This is a bounded proposal only. Do not return commands, argv, scripts, SQL, or tool calls.",
    ].join("\n"),
    validate: (structured, context) => {
      const parsed = ShepherdRepairProposalSchema.parse(structured);
      validateScope(parsed.scopeHash, context);
      const operations = context.contract?.eligibleOperations ?? [];
      if (!operations.includes(parsed.eligibleOperation)) {
        throw new Error(`repair operation is not eligible: ${parsed.eligibleOperation}`);
      }
      const entries = context.accepted.entries();
      const accepted = new Map(entries.map((entry) => [entry.claim.key, entry]));
      const missing = parsed.acceptedClaimKeys.find((key) => !accepted.has(key));
      if (missing !== undefined) throw new Error(`repair proposal cites unaccepted claim: ${missing}`);
      const proposedEvidence = new Map(parsed.sourceEvidence.map((entry) => [entry.ref, entry.hash.replace(/^sha256:/, "")]));
      for (const key of parsed.acceptedClaimKeys) {
        const entry = accepted.get(key)!;
        const evidenceHashes = new Map(
          (entry.evidence.stages.raw ?? []).map((source) => [source.ref, source.sha256]),
        );
        for (const evidenceRef of entry.claim.evidenceRefs) {
          if (proposedEvidence.get(evidenceRef) !== evidenceHashes.get(evidenceRef)) {
            throw new Error(`repair proposal does not bind accepted evidence: ${evidenceRef}`);
          }
        }
      }
      for (const source of parsed.sourceEvidence) {
        const expected = parsed.acceptedClaimKeys.some((key) => {
          const entry = accepted.get(key)!;
          return (entry.evidence.stages.raw ?? [])
            .some((candidate) => candidate.ref === source.ref && candidate.sha256 === source.hash.replace(/^sha256:/, ""));
        });
        if (!expected) throw new Error(`repair proposal cites evidence absent from accepted claims: ${source.ref}`);
      }
      if (Date.parse(parsed.expiresAt) <= context.now().getTime()) {
        throw new Error("repair proposal is expired");
      }
      return parsed;
    },
  });
  return registry;
}
