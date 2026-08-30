/** Runtime authority cap for the deterministic operations controller. */
import type { SopAuthority } from "@helium/core/operations/sop.js";
import { z } from "zod";

export const OPS_MODES = ["observe", "suggest", "approve", "auto"] as const;
export const OpsModeSchema = z.enum(OPS_MODES);
export type OpsMode = z.infer<typeof OpsModeSchema>;

export interface RuntimeModeInput {
  mode: OpsMode;
  /** Effective authority after signed-manifest resolution. */
  authority: SopAuthority;
  /** Eligibility excluding the presence of an operator approval. */
  eligible: boolean;
  /** A matching, unexpired, signature-verified approval is held. */
  approved: boolean;
}

export type RuntimeModeDecision =
  | { disposition: "observe"; reason: string }
  | { disposition: "propose"; reason?: string }
  | { disposition: "execute" };

/**
 * Apply the runtime mode as a CAP, never as a grant.
 *
 * `auto` in configuration is still only automatic when the signed manifest
 * granted `auto`; an `approve` SOP keeps requiring an approval even when the
 * daemon itself runs in auto mode. Conversely, approve mode deliberately
 * requires an approval even for an auto-capable SOP.
 */
export function decideRuntimeMode(input: RuntimeModeInput): RuntimeModeDecision {
  if (!input.eligible) {
    return { disposition: "observe", reason: "policy-ineligible" };
  }
  if (input.authority === "observe" || input.authority === "forbidden") {
    return {
      disposition: "observe",
      reason: `authority-${input.authority}`,
    };
  }
  if (input.mode === "observe") {
    return { disposition: "observe", reason: "runtime-observe" };
  }
  if (input.mode === "suggest") return { disposition: "propose" };

  const approvalRequired =
    input.mode === "approve" || input.authority === "approve";
  if (approvalRequired && !input.approved) {
    return { disposition: "propose", reason: "approval-required" };
  }
  return { disposition: "execute" };
}
