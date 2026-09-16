import { compareUtility, type MeasureVector, type UtilityPolicy } from './utility.js';

/** Operator-normalized trial evidence. The runner, not this comparator, verifies provenance. */
export interface FrameworkTrial {
  taskId: string;
  strategyCampaignId: string;
  frameworkRevision: string;
  selectedCandidateId: string;
  inputWorldHash: string;
  evaluatorVersion: string;
  selectionRuleVersion: string;
  modelRoute: string;
  maxCalls: number;
  maxElapsedMs: number;
  verified: boolean;
  strategyMeasures: MeasureVector;
  humanCorrections: number;
  costUsd: number | null;
  elapsedMs: number;
  callsUsed: number;
  tokensUsed: number | null;
}

const positive = (n: number) => Number.isFinite(n) && n > 0;
const count = (n: number) => Number.isSafeInteger(n) && n >= 0;
function valid(t: FrameworkTrial): boolean {
  return t.verified === true && [t.taskId, t.strategyCampaignId, t.frameworkRevision,
    t.selectedCandidateId, t.inputWorldHash, t.evaluatorVersion, t.selectionRuleVersion,
    t.modelRoute].every(s => typeof s === 'string' && s.trim().length > 0)
    && count(t.maxCalls) && t.maxCalls > 0 && positive(t.maxElapsedMs)
    && count(t.callsUsed) && t.callsUsed <= t.maxCalls
    && Number.isFinite(t.elapsedMs) && t.elapsedMs >= 0 && t.elapsedMs <= t.maxElapsedMs
    && count(t.humanCorrections) && (t.tokensUsed === null || count(t.tokensUsed))
    && (t.costUsd === null || (Number.isFinite(t.costUsd) && t.costUsd >= 0));
}

export function compareFramework(
  policy: UtilityPolicy, base: FrameworkTrial, candidate: FrameworkTrial,
): { status: 'better' | 'worse' | 'tied' | 'incomparable'; reason: string } {
  if (!valid(base) || !valid(candidate)) return { status: 'incomparable', reason: 'invalid-trial' };
  const shared = ['taskId', 'strategyCampaignId', 'inputWorldHash', 'evaluatorVersion',
    'selectionRuleVersion', 'modelRoute', 'maxCalls', 'maxElapsedMs'] as const;
  if (shared.some(key => base[key] !== candidate[key]))
    return { status: 'incomparable', reason: 'task-or-protocol-mismatch' };
  if (base.frameworkRevision === candidate.frameworkRevision)
    return { status: 'incomparable', reason: 'unchanged-framework' };
  const strategy = compareUtility(policy, base.strategyMeasures, candidate.strategyMeasures);
  if (!strategy.eligible) return { status: 'incomparable', reason: 'invalid-strategy-measures' };
  if (strategy.improved) return { status: 'better', reason: 'strategy-utility' };
  if (strategy.reason !== 'no-significant-improvement') return { status: 'worse', reason: 'strategy-utility' };
  for (const key of ['humanCorrections', 'costUsd', 'elapsedMs'] as const) {
    const before = base[key], after = candidate[key];
    if (before === null || after === null) return { status: 'incomparable', reason: `unmeasured-${key}` };
    if (after !== before) return { status: after < before ? 'better' : 'worse', reason: key };
  }
  return { status: 'tied', reason: 'equal-utility-and-resources' };
}
