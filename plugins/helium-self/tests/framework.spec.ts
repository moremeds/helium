import { expect, it } from 'vitest';
import { compareFramework, type FrameworkTrial } from '../evolution/framework.js';
const policy = { constraint: { metric: 'loss', upperBound: 0.15 },
  objectives: [{ metric: 'reward', direction: 'higher' as const, epsilon: 0.001 }] };
// Synthetic evaluator units, not market observations.
const base: FrameworkTrial = { taskId:'t', strategyCampaignId:'s', frameworkRevision:'a', selectedCandidateId:'x',
  inputWorldHash:'world', evaluatorVersion:'e', selectionRuleVersion:'v1', modelRoute:'route',
  maxCalls:10, maxElapsedMs:100, verified:true, strategyMeasures:{ loss:0.1, reward:0.2 },
  humanCorrections:2, costUsd:1, elapsedMs:50, callsUsed:3, tokensUsed:null };
const candidate = { ...base, frameworkRevision:'b', selectedCandidateId:'y' };
it('compares strategy first and resource ties under the same task and budget', () => {
  expect(compareFramework(policy, base, {...candidate, humanCorrections:1}).reason).toBe('humanCorrections');
  expect(compareFramework(policy, base, {...candidate, costUsd:0.5}).status).toBe('better');
  expect(compareFramework(policy, base, {...candidate, strategyMeasures:{loss:0.2,reward:0.9}, costUsd:0}).status).toBe('worse');
});
it('refuses mismatched trials, missing cost, and over-budget results', () => {
  for (const c of [{...candidate,maxCalls:20}, {...candidate,costUsd:null}, {...candidate,callsUsed:11}, base])
    expect(compareFramework(policy, base, c).status).toBe('incomparable');
});
it('does not let unmeasured lower-priority cost override fewer human corrections', () => {
  expect(compareFramework(policy, {...base,costUsd:null}, {...candidate,costUsd:null,humanCorrections:1}))
    .toEqual({status:'better', reason:'humanCorrections'});
  expect(compareFramework(policy, {...base,costUsd:null}, {...candidate,costUsd:null,elapsedMs:1}).status)
    .toBe('incomparable');
});
