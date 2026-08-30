import {
  EntitlementCertificationSchema,
  type EntitlementCertification,
} from "@helium/provider-sdk/registration";

export interface ProviderCertifications {
  codex: EntitlementCertification;
  deepseek: EntitlementCertification;
  claude: EntitlementCertification;
}

/**
 * Sanitized, versioned entitlement artifacts. Catalog inventory is deliberately
 * not certification: only exact variants named here can enter routing.
 */
export const productionProviderCertifications: ProviderCertifications = {
  codex: EntitlementCertificationSchema.parse({
    certificationVersion: "codex-macmini-live-2026-08-30-v1",
    catalogSnapshotHash:
      "fa7cd96ef1cd54c0840d92be8ab23917bbb1e435bfe6c588e527c7e0289a7f0d",
    recordedAt: "2026-08-30T10:08:32.564Z",
    source: "macmini-live-preflight:codex-cli-0.148.0-alpha.9:https-fallback",
    targets: [{ targetRef: "gpt-5.6-sol", variants: ["high"] }],
  }),
  deepseek: EntitlementCertificationSchema.parse({
    certificationVersion: "deepseek-unavailable-2026-08-30-v1",
    catalogSnapshotHash:
      "d3049ece1b355b8c584b914fd5eb9c95e6cf199e49f57b724575e30cefdb4aaa",
    recordedAt: "2026-08-30T08:39:00.000Z",
    source: "preflight-blocked:no-development-credential",
    targets: [],
  }),
  claude: EntitlementCertificationSchema.parse({
    certificationVersion: "claude-unavailable-2026-08-30-v1",
    catalogSnapshotHash:
      "dad0a1b960a6c1fde7714e45359ef1a8c5f7400d86bfabf0d19c5d5f530489b8",
    recordedAt: "2026-08-30T08:39:00.000Z",
    source: "live-preflight-skipped:quota-exhausted",
    targets: [],
  }),
};
