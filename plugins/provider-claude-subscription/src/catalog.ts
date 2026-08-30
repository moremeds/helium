import {
  parseProviderCatalog,
  providerCatalogSnapshotHash,
  type ProviderCatalog,
  type ProviderTarget,
} from "@helium/provider-sdk";

export const CLAUDE_EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORT_ORDER)[number];

type ProviderEffort = ProviderTarget["effort"];

const DEFAULT_TARGETS: ProviderTarget[] = [
  {
    targetRef: "claude-haiku-4-5-20251001",
    model: "claude-haiku-4-5-20251001",
    invokeAs: "haiku",
    quotaDomain: "claude-subscription-session",
    enabled: true,
    effort: { supported: false },
  },
  {
    targetRef: "claude-sonnet-5",
    model: "claude-sonnet-5",
    invokeAs: "sonnet",
    quotaDomain: "claude-subscription-session",
    enabled: true,
    effort: {
      supported: true,
      options: [...CLAUDE_EFFORT_ORDER],
      default: "high",
    },
  },
  {
    targetRef: "claude-opus-5",
    model: "claude-opus-5",
    invokeAs: "opus",
    quotaDomain: "claude-subscription-session",
    enabled: true,
    effort: {
      supported: true,
      options: [...CLAUDE_EFFORT_ORDER],
      default: "high",
    },
  },
];

export interface ClaudeCatalog extends ProviderCatalog {
  snapshotHash: string;
  source: {
    kind: "sanitized-historical-preflight";
    recordedAt: string;
    liveCapacity: "quota-exhausted";
  };
  executionModes: { ultracode: { enabled: false; reason: string } };
}

export function createClaudeCatalog(targets: ProviderTarget[]): ClaudeCatalog {
  const parsed = parseProviderCatalog({
    catalogVersion: "claude-macmini-2026-08-25-historical",
    targets,
  });
  return {
    ...parsed,
    snapshotHash: providerCatalogSnapshotHash(parsed),
    source: {
      kind: "sanitized-historical-preflight",
      recordedAt: "2026-08-25T00:00:00.000Z",
      liveCapacity: "quota-exhausted",
    },
    executionModes: {
      ultracode: {
        enabled: false,
        reason: "provider-owned-agent-orchestration",
      },
    },
  };
}

export const claudeSubscriptionCatalog = createClaudeCatalog(DEFAULT_TARGETS);

export function applyClaudeEffortCap(
  effort: ProviderEffort,
  cap: ClaudeEffort,
): ProviderEffort {
  if (!effort.supported) return effort;
  const capIndex = CLAUDE_EFFORT_ORDER.indexOf(cap);
  const options = effort.options.filter(
    (option) =>
      CLAUDE_EFFORT_ORDER.indexOf(option as ClaudeEffort) <= capIndex,
  );
  const defaultEffort = options.includes(effort.default)
    ? effort.default
    : options.at(-1);
  if (defaultEffort === undefined) throw new Error("effort cap permits no option");
  return { supported: true, options, default: defaultEffort };
}

export function resolveClaudeEffort(
  target: ProviderTarget,
  requested: string | undefined,
): ClaudeEffort | undefined {
  if (!target.effort.supported) {
    if (requested !== undefined) throw new Error("effort unsupported by target");
    return undefined;
  }
  const resolved = requested ?? target.effort.default;
  if (!target.effort.options.includes(resolved)) {
    throw new Error(`unsupported Claude effort: ${resolved}`);
  }
  return resolved as ClaudeEffort;
}
