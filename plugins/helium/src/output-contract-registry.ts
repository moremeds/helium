import { z } from "zod";
import {
  AcceptedClaimLedger,
  ClaimSchema,
  ClaimSetSchema,
  EvidenceBundleSchema,
  acceptEvidence,
  canonicalJson,
  type AgentResult,
  type Claim,
  type ClaimDecision,
  type ClaimSet,
  type EvidenceBundle,
} from "@helium/core";

export interface ClaimOutput {
  claimSet: ClaimSet;
  evidence: EvidenceBundle[];
}

export interface OutputContractContext {
  role: string;
  evidenceRefs: string[];
  accepted: AcceptedClaimLedger;
  result: AgentResult;
  evidenceInputs: Map<string, { hash: string; content: string }>;
  now: () => Date;
  allowPartialClaims: boolean;
  contract?: {
    scopeHash?: string;
    eligibleOperations?: string[];
  };
}

export interface OutputContractDefinition {
  prompt(context: Pick<OutputContractContext, "role" | "evidenceRefs" | "contract">): string;
  validate(value: unknown, context: OutputContractContext): unknown;
  extractClaims?(value: unknown, context?: OutputContractContext): ClaimOutput | undefined;
}

const ClaimSetOutputSchema = z.strictObject({
  claimSet: ClaimSetSchema,
  evidence: z.array(EvidenceBundleSchema),
});
const ClaimSetDraftSchema = z.strictObject({ claimSet: ClaimSetSchema });
const ClaimDecisionSchema = z.strictObject({
  actorRole: z.enum(["agent", "verifier", "renderer"]),
  claim: ClaimSchema,
  evidence: EvidenceBundleSchema,
});
const EvidenceDecisionSetSchema = z.strictObject({ decisions: z.array(ClaimDecisionSchema) });
const EvidenceDecisionDraftSchema = z.strictObject({ acceptedClaimKeys: z.array(z.string().min(1)) });
const SynthesisSchema = z.strictObject({
  summary: z.string().min(1),
  acceptedClaimKeys: z.array(z.string().min(1)),
});
const ShadowReportSchema = z.strictObject({
  report: z.string().min(1),
  acceptedClaimKeys: z.array(z.string().min(1)),
});

const jsonOnly = "Return exactly one JSON object with no markdown fence or commentary.";

export class OutputContractRegistry {
  readonly #definitions = new Map<string, OutputContractDefinition>();

  register(id: string, definition: OutputContractDefinition): this {
    if (this.#definitions.has(id)) throw new Error(`team output schema already registered: ${id}`);
    this.#definitions.set(id, definition);
    return this;
  }

  prompt(
    id: string,
    context: Pick<OutputContractContext, "role" | "evidenceRefs" | "contract">,
  ): string {
    return this.#definition(id).prompt(context);
  }

  validate(id: string, value: unknown, context: OutputContractContext): unknown {
    return this.#definition(id).validate(parseStructured(value), context);
  }

  extractClaimOutputs(value: unknown, context?: OutputContractContext): ClaimOutput[] {
    const structured = parseStructured(value);
    return [...this.#definitions.values()].flatMap((definition) => {
      const output = definition.extractClaims?.(structured, context);
      return output === undefined ? [] : [output];
    });
  }

  has(id: string): boolean {
    return this.#definitions.has(id);
  }

  #definition(id: string): OutputContractDefinition {
    const definition = this.#definitions.get(id);
    if (definition === undefined) throw new Error(`unknown team output schema: ${id}`);
    return definition;
  }
}

export function createBuiltinOutputContractRegistry(): OutputContractRegistry {
  const registry = new OutputContractRegistry();
  registry.register("ClaimSet.v1", {
    prompt: ({ role, evidenceRefs }) => [
      jsonOnly,
      "Schema: {\"claimSet\":{\"claimSetId\":string,\"producerRole\":string,\"claims\":[{\"key\":string,\"statement\":string,\"kind\":\"fact\"|\"inference\"|\"judgment\",\"evidenceRefs\":string[],\"confidence\":number,\"assumptions\":string[],\"asOf\":ISO-UTC-string-for-facts}]}}.",
      `producerRole must be ${JSON.stringify(role)}.`,
      `Every evidenceRefs entry must be chosen from: ${JSON.stringify(evidenceRefs)}.`,
      "Use facts only when directly supported. Inferences and judgments require named assumptions.",
    ].join("\n"),
    validate: (structured, context) => validateClaimSet(structured, context),
    extractClaims: (value) => {
      const parsed = ClaimSetOutputSchema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    },
  });
  registry.register("EvidenceDecisionSet.v1", {
    prompt: () => [
      jsonOnly,
      "Schema: {\"acceptedClaimKeys\":string[]}.",
      "Accept only claim keys whose statement is supported by the supplied immutable evidence. Disagreement requires fresh evidence, never a vote.",
    ].join("\n"),
    validate: (structured, context) => {
      const supplied = EvidenceDecisionSetSchema.safeParse(structured);
      if (supplied.success) return supplied.data;
      const draft = EvidenceDecisionDraftSchema.parse(structured);
      const candidates = [...context.evidenceInputs.values()].flatMap((input) => {
        let decoded: unknown;
        try {
          decoded = JSON.parse(input.content);
        } catch {
          return [];
        }
        return registry.extractClaimOutputs(decoded, context).flatMap((output) =>
          output.claimSet.claims.map((claim) => ({
            claim,
            evidence: output.evidence.find((candidate) => candidate.assertionId === claim.key),
          })),
        );
      });
      return EvidenceDecisionSetSchema.parse({
        decisions: draft.acceptedClaimKeys.map((key) => {
          const candidate = candidates.find((entry) => entry.claim.key === key && entry.evidence !== undefined);
          if (candidate?.evidence === undefined) throw new Error(`verifier accepted unknown claim key: ${key}`);
          return { actorRole: "verifier", claim: candidate.claim, evidence: candidate.evidence };
        }),
      });
    },
  });
  registry.register("AdjudicatedSynthesis.v1", {
    prompt: () => `${jsonOnly}\nSchema: {\"summary\":string,\"acceptedClaimKeys\":string[]}. Use only keys present in the accepted claim ledger.`,
    validate: (structured, context) => validateAcceptedKeys(SynthesisSchema.parse(structured), context),
  });
  registry.register("ShadowReport.v1", {
    prompt: () => `${jsonOnly}\nSchema: {\"report\":string,\"acceptedClaimKeys\":string[]}. Use only keys present in the accepted claim ledger. This is review-only, not trading advice.`,
    validate: (structured, context) => validateAcceptedKeys(ShadowReportSchema.parse(structured), context),
  });
  return registry;
}

function validateClaimSet(structured: unknown, context: OutputContractContext): ClaimOutput {
  const supplied = ClaimSetOutputSchema.safeParse(structured);
  const output = supplied.success ? supplied.data : enrichClaimDraft(ClaimSetDraftSchema.parse(structured), context);
  if (output.evidence.length !== output.claimSet.claims.length) {
    throw new Error("every claim requires one evidence bundle");
  }
  for (const claim of output.claimSet.claims) {
    const evidence = output.evidence.find((candidate) => candidate.assertionId === claim.key);
    if (evidence === undefined || evidence.assertion !== claim.statement) {
      throw new Error(`claim ${claim.key} has missing or mismatched provenance`);
    }
    if (canonicalJson(evidence.executionSnapshot) !== canonicalJson(context.result.executionSnapshot)) {
      throw new Error(`claim ${claim.key} execution snapshot does not match its result`);
    }
    acceptEvidence(evidence, context.now());
    new AcceptedClaimLedger({ allowPartial: context.allowPartialClaims }).publish(
      { actorRole: "agent", claim, evidence },
      context.now(),
    );
  }
  return output;
}

function enrichClaimDraft(
  draft: z.infer<typeof ClaimSetDraftSchema>,
  context: OutputContractContext,
): ClaimOutput {
  const decidedAt = context.now().toISOString();
  return ClaimSetOutputSchema.parse({
    claimSet: draft.claimSet,
    evidence: draft.claimSet.claims.map((claim) => buildPartialEvidence(claim, context, decidedAt)),
  });
}

function buildPartialEvidence(
  claim: Claim,
  context: OutputContractContext,
  decidedAt: string,
): EvidenceBundle {
  const executionRefs = [...context.evidenceInputs.keys()].filter((ref) =>
    ref.startsWith("artifact://team-execution/"),
  );
  const raw = [...new Set([...claim.evidenceRefs, ...executionRefs])].map((ref) => {
    const input = context.evidenceInputs.get(ref);
    if (input === undefined) throw new Error(`claim ${claim.key} cites undeclared input: ${ref}`);
    return { ref, sha256: input.hash.replace(/^sha256:/, "") };
  });
  const replayRequired = claim.kind !== "judgment";
  return EvidenceBundleSchema.parse({
    assertionId: claim.key,
    assertion: claim.statement,
    acceptanceBound: "Review-only canary validates schema, execution identity, and immutable cited inputs.",
    assertionClass: `claim:${claim.kind}`,
    evidencePolicyVersion: "claim-review-v1",
    requiredStages: replayRequired ? ["raw", "replay"] : ["raw"],
    stages: { raw },
    ...(replayRequired
      ? { notApplicable: { replay: "Independent semantic replay remains pending in review-only canary." } }
      : {}),
    verifier: { identity: "helium-input-binding", version: "1", decision: "inconclusive", decidedAt },
    freshness: { recordedAt: decidedAt },
    executionSnapshot: context.result.executionSnapshot,
    status: "PARTIAL",
    limitation: "Semantic correctness and independent replay require human review.",
  });
}

function validateAcceptedKeys<T extends { acceptedClaimKeys: string[] }>(
  value: T,
  context: OutputContractContext,
): T {
  const acceptedKeys = new Set(context.accepted.entries().map((entry: ClaimDecision) => entry.claim.key));
  if (value.acceptedClaimKeys.some((key) => !acceptedKeys.has(key))) {
    throw new Error("output cites a claim absent from the accepted claim ledger");
  }
  return value;
}

function parseStructured(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)?.[1] ?? trimmed;
  try {
    return JSON.parse(fenced);
  } catch {
    throw new Error("team result is not valid JSON");
  }
}
