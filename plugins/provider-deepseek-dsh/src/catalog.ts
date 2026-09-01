import {
  parseProviderCatalog,
  providerCatalogSnapshotHash,
  type ProviderCatalog,
  type ProviderTarget,
} from "@helium/provider-sdk";

export const DEEPSEEK_EFFORT_ORDER = ["off", "low", "high", "max"] as const;
export type DeepSeekEffort = (typeof DEEPSEEK_EFFORT_ORDER)[number];

const DEFAULT_TARGETS: ProviderTarget[] = [
  {
    targetRef: "deepseek-v4-flash",
    model: "deepseek-v4-flash",
    quotaDomain: "deepseek-api-key",
    enabled: true,
    effort: {
      supported: true,
      options: [...DEEPSEEK_EFFORT_ORDER],
      default: "high",
    },
  },
  {
    targetRef: "deepseek-v4-pro",
    model: "deepseek-v4-pro",
    quotaDomain: "deepseek-api-key",
    enabled: true,
    effort: {
      supported: true,
      options: [...DEEPSEEK_EFFORT_ORDER],
      default: "high",
    },
  },
  {
    targetRef: "deepseek-v4-flash-vision-exp",
    model: "deepseek-v4-flash-vision-exp",
    quotaDomain: "deepseek-api-key",
    enabled: false,
    effort: {
      supported: true,
      options: [...DEEPSEEK_EFFORT_ORDER],
      default: "high",
    },
  },
];

export interface DeepSeekCatalog extends ProviderCatalog {
  snapshotHash: string;
  source: {
    kind: "sanitized-live-preflight";
    recordedAt: string;
    hostClass: "mac-mini";
    dshVersion: string;
  };
}

// The version strings below are NOT pins — they record which dsh the sanitized
// live preflight actually ran against on 2026-08-25. They deliberately still say
// 0.1.1-rc.2 after the 0.1.2-alpha.3 promotion: rewriting them would claim a
// measurement nobody took. Re-run the preflight on the new dsh, then bump both
// together with a new recordedAt.
export function createDeepSeekCatalog(targets: ProviderTarget[]): DeepSeekCatalog {
  const parsed = parseProviderCatalog({
    catalogVersion: "deepseek-macmini-2026-08-25-dsh-0.1.1-rc.2",
    targets,
  });
  return {
    ...parsed,
    snapshotHash: providerCatalogSnapshotHash(parsed),
    source: {
      kind: "sanitized-live-preflight",
      recordedAt: "2026-08-25T00:00:00.000Z",
      hostClass: "mac-mini",
      dshVersion: "0.1.1-rc.2",
    },
  };
}

export const deepseekDshCatalog = createDeepSeekCatalog(DEFAULT_TARGETS);

export function resolveDeepSeekEffort(
  target: ProviderTarget,
  requested: string | undefined,
): DeepSeekEffort | undefined {
  if (!target.effort.supported) {
    if (requested !== undefined) throw new Error("effort unsupported by target");
    return undefined;
  }
  const resolved = requested ?? target.effort.default;
  if (!DEEPSEEK_EFFORT_ORDER.includes(resolved as DeepSeekEffort)) {
    throw new Error(`unsupported DeepSeek effort: ${resolved}`);
  }
  if (!target.effort.options.includes(resolved)) {
    throw new Error(`uncertified DeepSeek effort: ${resolved}`);
  }
  return resolved as DeepSeekEffort;
}
