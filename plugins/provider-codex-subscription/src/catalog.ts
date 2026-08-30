import {
  parseProviderCatalog,
  providerCatalogSnapshotHash,
  type ProviderCatalog,
  type ProviderTarget,
} from "@helium/provider-sdk";

export const CODEX_EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"] as const;
export type CodexEffort = (typeof CODEX_EFFORT_ORDER)[number];

const current = (model: string, defaultEffort: CodexEffort): ProviderTarget => ({
  targetRef: model,
  model,
  quotaDomain: "codex-subscription-session",
  enabled: true,
  effort: {
    supported: true,
    options: [...CODEX_EFFORT_ORDER],
    default: defaultEffort,
  },
});

const legacy = (model: string, defaultEffort = "medium"): ProviderTarget => ({
  targetRef: model,
  model,
  quotaDomain: "codex-subscription-session",
  enabled: false,
  effort: {
    supported: true,
    options: ["low", "medium", "high", "xhigh"],
    default: defaultEffort,
  },
});

const DEFAULT_TARGETS: ProviderTarget[] = [
  current("gpt-5.6-sol", "low"),
  current("gpt-5.6-terra", "medium"),
  current("gpt-5.6-luna", "medium"),
  legacy("gpt-5.5"),
  legacy("gpt-5.4"),
  legacy("gpt-5.4-mini"),
  legacy("gpt-5.3-codex-spark", "high"),
  {
    ...current("codex-auto-review", "medium"),
    enabled: false,
  },
];

export interface CodexCatalog extends ProviderCatalog {
  snapshotHash: string;
  source: {
    kind: "sanitized-local-account-cache";
    recordedAt: string;
    cliVersion: string;
  };
  executionModes: { ultra: { enabled: false; reason: string } };
  disabledReasons: Readonly<Record<string, string>>;
}

export function createCodexCatalog(targets: ProviderTarget[]): CodexCatalog {
  const parsed = parseProviderCatalog({
    catalogVersion: "codex-local-2026-08-30-cli-0.140.0",
    targets,
  });
  return {
    ...parsed,
    snapshotHash: providerCatalogSnapshotHash(parsed),
    source: {
      kind: "sanitized-local-account-cache",
      recordedAt: "2026-08-30T00:00:00.000Z",
      cliVersion: "0.140.0",
    },
    executionModes: {
      ultra: { enabled: false, reason: "provider-owned-agent-orchestration" },
    },
    disabledReasons: {
      "gpt-5.5": "legacy",
      "gpt-5.4": "retires-2026-08-31",
      "gpt-5.4-mini": "retires-2026-08-31",
      "gpt-5.3-codex-spark": "not-live-certified-on-macmini",
      "codex-auto-review": "special-review-target",
    },
  };
}

export const codexSubscriptionCatalog = createCodexCatalog(DEFAULT_TARGETS);

export function resolveCodexEffort(
  target: ProviderTarget,
  requested: string | undefined,
): CodexEffort | undefined {
  if (requested === "ultra") {
    throw new Error("Codex ultra is an orchestration mode, not effort");
  }
  if (!target.effort.supported) {
    if (requested !== undefined) throw new Error("effort unsupported by target");
    return undefined;
  }
  const resolved = requested ?? target.effort.default;
  if (!target.effort.options.includes(resolved)) {
    throw new Error(`unsupported Codex effort: ${resolved}`);
  }
  return resolved as CodexEffort;
}
