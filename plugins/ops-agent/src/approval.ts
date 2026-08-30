/** Signed, scoped operator approval and intervention envelopes. */
import { createHash, verify, type KeyObject } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { canonicalJson, openEventStore } from "@helium/core";
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
  promotionId: OpsIdSchema,
  promotionInputSha256: z.string().regex(/^[0-9a-f]{64}$/),
  attempt: z.literal(1),
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

const AcceptedApprovalSchema = ApprovalPayloadSchema.extend({
  operatorId: OpsIdSchema,
}).strict();

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

const SuggestionDecisionPayloadSchema = z.strictObject({
  actionId: OpsIdSchema,
  incidentId: OpsIdSchema,
  componentId: OpsIdSchema,
  sopId: OpsIdSchema,
  sopVersion: z.number().int().positive(),
  sopDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  decision: z.enum(["accepted", "rejected", "alternate"]),
  reason: z.string().min(1).max(1000),
  at: IsoTimestampSchema,
});

const UnsignedSuggestionDecisionEnvelopeSchema = z.strictObject({
  kind: z.literal("suggestion-decision"),
  operatorId: OpsIdSchema,
  nonce: NonceSchema,
  issuedAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
  decision: SuggestionDecisionPayloadSchema,
});

export const SignedSuggestionDecisionEnvelopeSchema =
  UnsignedSuggestionDecisionEnvelopeSchema.extend({
    signature: z.string().min(1).max(4096),
  }).strict();
export type SignedSuggestionDecisionEnvelope = z.infer<
  typeof SignedSuggestionDecisionEnvelopeSchema
>;

type UnsignedApprovalEnvelope = z.infer<typeof UnsignedApprovalEnvelopeSchema>;
type UnsignedInterventionEnvelope = z.infer<
  typeof UnsignedInterventionEnvelopeSchema
>;
type UnsignedSuggestionDecisionEnvelope = z.infer<
  typeof UnsignedSuggestionDecisionEnvelopeSchema
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

export function suggestionDecisionSigningPayload(
  raw: UnsignedSuggestionDecisionEnvelope,
): Buffer {
  const value = UnsignedSuggestionDecisionEnvelopeSchema.parse(raw);
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

export interface OperatorEnvelopePersistence {
  consumeNonce(nonce: string): void;
  loadApprovals(): AcceptedApproval[];
  saveApproval(approval: AcceptedApproval): void;
}

class MemoryOperatorEnvelopeStore implements OperatorEnvelopePersistence {
  readonly #used = new Set<string>();
  readonly #approvals = new Map<string, AcceptedApproval>();

  consumeNonce(nonce: string): void {
    if (this.#used.has(nonce)) throw new Error(`operator nonce replay: ${nonce}`);
    this.#used.add(nonce);
  }

  loadApprovals(): AcceptedApproval[] {
    return [...this.#approvals.values()].map((approval) => ({ ...approval }));
  }

  saveApproval(approval: AcceptedApproval): void {
    this.#approvals.set(keyOf(approval.incidentId, approval.sopId), { ...approval });
  }
}

/** Durable, process-independent nonce and accepted-approval store. */
export class FileOperatorEnvelopeStore implements OperatorEnvelopePersistence {
  readonly #nonceDir: string;
  readonly #approvalDir: string;

  constructor(dir: string) {
    assertPrivateDirectory(dir);
    this.#nonceDir = join(dir, "nonces");
    this.#approvalDir = join(dir, "approvals");
    assertPrivateDirectory(this.#nonceDir);
    assertPrivateDirectory(this.#approvalDir);
  }

  consumeNonce(nonce: string): void {
    const path = join(this.#nonceDir, `${hashId(nonce)}.json`);
    try {
      writeFileSync(path, `${JSON.stringify({ nonce })}\n`, {
        mode: 0o600,
        flag: "wx",
        flush: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`operator nonce replay: ${nonce}`);
      }
      throw error;
    }
  }

  loadApprovals(): AcceptedApproval[] {
    return readdirSync(this.#approvalDir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => {
        const path = join(this.#approvalDir, name);
        const stat = lstatSync(path);
        if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
          throw new Error(`approval ledger file must be owner-only: ${path}`);
        }
        return AcceptedApprovalSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      });
  }

  saveApproval(approval: AcceptedApproval): void {
    const parsed = AcceptedApprovalSchema.parse(approval);
    const id = hashId(keyOf(parsed.incidentId, parsed.sopId));
    const target = join(this.#approvalDir, `${id}.json`);
    const staging = join(this.#approvalDir, `.${id}.${process.pid}.tmp`);
    writeFileSync(staging, `${JSON.stringify(parsed)}\n`, {
      mode: 0o600,
      flag: "wx",
      flush: true,
    });
    renameSync(staging, target);
    const fd = openSync(this.#approvalDir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

export class ApprovalLedger {
  readonly #persistence: OperatorEnvelopePersistence;
  readonly #approvals = new Map<string, AcceptedApproval>();

  constructor(
    private readonly options: {
      trustedKey: KeyObject;
      now: () => Date;
      persistence?: OperatorEnvelopePersistence;
    },
  ) {
    this.#persistence = options.persistence ?? new MemoryOperatorEnvelopeStore();
    for (const approval of this.#persistence.loadApprovals()) {
      this.#approvals.set(keyOf(approval.incidentId, approval.sopId), approval);
    }
  }

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
    this.#persistence.consumeNonce(envelope.nonce);
    const accepted: AcceptedApproval = {
      ...envelope.approval,
      operatorId: envelope.operatorId,
    };
    this.#persistence.saveApproval(accepted);
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

export interface AcceptedSuggestionDecision {
  actionId: string;
  incidentId: string;
  componentId: string;
  sopId: string;
  sopVersion: number;
  sopDigest: string;
  decision: "accepted" | "rejected" | "alternate";
  reason: string;
  at: string;
  operatorId: string;
}

const SuggestionDecisionRecordSchema = z.strictObject({
  version: z.literal(1),
  actionId: OpsIdSchema,
  incidentId: OpsIdSchema,
  componentId: OpsIdSchema,
  sopId: OpsIdSchema,
  sopVersion: z.number().int().positive(),
  sopDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  decision: z.enum(["accepted", "rejected", "alternate"]),
  reason: z.string().min(1).max(1000),
  at: IsoTimestampSchema,
  operatorId: OpsIdSchema,
});
export type SuggestionDecisionRecord = z.infer<typeof SuggestionDecisionRecordSchema>;

export interface SuggestionDecisionStorePort {
  record(value: AcceptedSuggestionDecision): SuggestionDecisionRecord;
  all(): SuggestionDecisionRecord[];
}

/**
 * Separate, hash-chained decision ledger. Keeping it outside events.jsonl
 * preserves rollback to an older observe-only opsd that does not know this
 * P4 review record type.
 */
export class FileSuggestionDecisionStore implements SuggestionDecisionStorePort {
  readonly #log;
  readonly #records: SuggestionDecisionRecord[];

  constructor(stateDir: string) {
    this.#log = openEventStore(join(stateDir, "suggestion-decisions"), {
      schema: SuggestionDecisionRecordSchema,
    });
    this.#records = this.#log.replay();
    const ids = new Set(this.#records.map((value) => value.actionId));
    if (ids.size !== this.#records.length) {
      throw new Error("duplicate suggestion decision in durable ledger");
    }
  }

  record(value: AcceptedSuggestionDecision): SuggestionDecisionRecord {
    if (this.#records.some((record) => record.actionId === value.actionId)) {
      throw new Error(`suggestion decision already recorded: ${value.actionId}`);
    }
    const record = SuggestionDecisionRecordSchema.parse({ version: 1, ...value });
    this.#log.append(record);
    this.#records.push(record);
    return { ...record };
  }

  all(): SuggestionDecisionRecord[] {
    return this.#records.map((value) => ({ ...value }));
  }
}

export class OperatorEnvelopeVerifier {
  readonly #persistence: OperatorEnvelopePersistence;

  constructor(
    private readonly options: {
      trustedKey: KeyObject;
      now: () => Date;
      persistence?: OperatorEnvelopePersistence;
    },
  ) {
    this.#persistence = options.persistence ?? new MemoryOperatorEnvelopeStore();
  }

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
    this.#persistence.consumeNonce(envelope.nonce);
    return {
      ...envelope.intervention,
      operatorId: envelope.operatorId,
    };
  }

  acceptSuggestionDecision(raw: unknown): AcceptedSuggestionDecision {
    const envelope = SignedSuggestionDecisionEnvelopeSchema.parse(raw);
    const { signature: _signature, ...unsigned } = envelope;
    verifyEnvelope(
      suggestionDecisionSigningPayload(unsigned),
      envelope.signature,
      this.options.trustedKey,
    );
    if (Date.parse(envelope.expiresAt) <= this.options.now().getTime()) {
      throw new Error("operator suggestion decision envelope is expired");
    }
    this.#persistence.consumeNonce(envelope.nonce);
    return {
      ...envelope.decision,
      operatorId: envelope.operatorId,
    };
  }
}

const keyOf = (incidentId: string, sopId: string): string =>
  `${incidentId}\u0000${sopId}`;

const hashId = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

function assertPrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = statSync(dir);
  if (!stat.isDirectory()) throw new Error(`operator ledger is not a directory: ${dir}`);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`operator ledger directory must be owner-only: ${dir}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`operator ledger directory has a different owner: ${dir}`);
  }
}
