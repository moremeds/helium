/** Signed, scoped operator approval and intervention envelopes. */
import { verify, type KeyObject } from "node:crypto";
import { canonicalJson } from "@helium/core";
import type { OperatorApproval } from "@helium/core/operations/authority.js";
import { z } from "zod";

const IsoTimestampSchema = z.string().datetime({ offset: true });
const NonceSchema = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/);
const OpsIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const ApprovalPayloadSchema = z.strictObject({
  incidentId: z.string().min(1).max(512),
  sopId: OpsIdSchema,
  sopVersion: z.number().int().positive(),
  sopDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  expiresAt: IsoTimestampSchema,
});

const UnsignedApprovalEnvelopeSchema = z.strictObject({
  kind: z.literal("approval"),
  operatorId: OpsIdSchema,
  nonce: NonceSchema,
  issuedAt: IsoTimestampSchema,
  approval: ApprovalPayloadSchema,
});

export const SignedApprovalEnvelopeSchema = UnsignedApprovalEnvelopeSchema.extend({
  signature: z.string().min(1).max(4096),
}).strict();
export type SignedApprovalEnvelope = z.infer<typeof SignedApprovalEnvelopeSchema>;

export interface AcceptedApproval extends OperatorApproval {
  operatorId: string;
}

const InterventionPayloadSchema = z.strictObject({
  componentId: OpsIdSchema,
  interventionKind: z.string().min(1).max(64),
  confirmed: z.boolean(),
  at: IsoTimestampSchema,
});

const UnsignedInterventionEnvelopeSchema = z.strictObject({
  kind: z.literal("intervention"),
  operatorId: OpsIdSchema,
  nonce: NonceSchema,
  issuedAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
  intervention: InterventionPayloadSchema,
});

export const SignedInterventionEnvelopeSchema =
  UnsignedInterventionEnvelopeSchema.extend({
    signature: z.string().min(1).max(4096),
  }).strict();
export type SignedInterventionEnvelope = z.infer<
  typeof SignedInterventionEnvelopeSchema
>;

type UnsignedApprovalEnvelope = z.infer<typeof UnsignedApprovalEnvelopeSchema>;
type UnsignedInterventionEnvelope = z.infer<
  typeof UnsignedInterventionEnvelopeSchema
>;

export function approvalSigningPayload(
  raw: UnsignedApprovalEnvelope,
): Buffer {
  const value = UnsignedApprovalEnvelopeSchema.parse(raw);
  return Buffer.from(canonicalJson(value), "utf8");
}

export function interventionSigningPayload(
  raw: UnsignedInterventionEnvelope,
): Buffer {
  const value = UnsignedInterventionEnvelopeSchema.parse(raw);
  return Buffer.from(canonicalJson(value), "utf8");
}

function verifyEnvelope(
  payload: Buffer,
  signature: string,
  trustedKey: KeyObject,
): void {
  let ok = false;
  try {
    ok = verify(null, payload, trustedKey, Buffer.from(signature, "base64"));
  } catch {
    ok = false;
  }
  if (!ok) throw new Error("operator envelope signature is invalid");
}

class NonceLedger {
  readonly #used = new Set<string>();

  consume(nonce: string): void {
    if (this.#used.has(nonce)) throw new Error(`operator nonce replay: ${nonce}`);
    this.#used.add(nonce);
  }
}

export class ApprovalLedger {
  readonly #nonces = new NonceLedger();
  readonly #approvals = new Map<string, AcceptedApproval>();

  constructor(
    private readonly options: { trustedKey: KeyObject; now: () => Date },
  ) {}

  accept(raw: unknown): AcceptedApproval {
    const envelope = SignedApprovalEnvelopeSchema.parse(raw);
    const { signature: _signature, ...unsigned } = envelope;
    verifyEnvelope(
      approvalSigningPayload(unsigned),
      envelope.signature,
      this.options.trustedKey,
    );
    if (Date.parse(envelope.approval.expiresAt) <= this.options.now().getTime()) {
      throw new Error("operator approval is expired");
    }
    this.#nonces.consume(envelope.nonce);
    const accepted: AcceptedApproval = {
      ...envelope.approval,
      operatorId: envelope.operatorId,
    };
    this.#approvals.set(keyOf(accepted.incidentId, accepted.sopId), accepted);
    return accepted;
  }

  find(incidentId: string, sopId: string): AcceptedApproval | undefined {
    const approval = this.#approvals.get(keyOf(incidentId, sopId));
    if (approval === undefined) return undefined;
    if (Date.parse(approval.expiresAt) <= this.options.now().getTime()) {
      this.#approvals.delete(keyOf(incidentId, sopId));
      return undefined;
    }
    return { ...approval };
  }
}

export interface AcceptedIntervention {
  componentId: string;
  interventionKind: string;
  confirmed: boolean;
  at: string;
  operatorId: string;
}

export class OperatorEnvelopeVerifier {
  readonly #nonces = new NonceLedger();

  constructor(
    private readonly options: { trustedKey: KeyObject; now: () => Date },
  ) {}

  acceptIntervention(raw: unknown): AcceptedIntervention {
    const envelope = SignedInterventionEnvelopeSchema.parse(raw);
    const { signature: _signature, ...unsigned } = envelope;
    verifyEnvelope(
      interventionSigningPayload(unsigned),
      envelope.signature,
      this.options.trustedKey,
    );
    if (Date.parse(envelope.expiresAt) <= this.options.now().getTime()) {
      throw new Error("operator intervention envelope is expired");
    }
    this.#nonces.consume(envelope.nonce);
    return {
      ...envelope.intervention,
      operatorId: envelope.operatorId,
    };
  }
}

const keyOf = (incidentId: string, sopId: string): string =>
  `${incidentId}\u0000${sopId}`;
