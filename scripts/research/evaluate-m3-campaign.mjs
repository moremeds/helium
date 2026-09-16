/** Evaluate operator-normalized evidence. This does not prove provenance or run a backtest. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { freezeCampaign, decideRetention } from '../../plugins/helium-self/lib/evolution/campaign.js';
import { compareUtility, evaluateStop } from '../../plugins/helium-self/lib/evolution/utility.js';
import { compareFramework } from '../../plugins/helium-self/lib/evolution/framework.js';

const [input, output] = process.argv.slice(2);
if (!input || !output || process.argv.length !== 4) throw new Error('usage: node scripts/research/evaluate-m3-campaign.mjs packet.json NEW_OUTPUT_DIR');
const bytes = readFileSync(input);
const packet = JSON.parse(bytes);
const contract = freezeCampaign(packet.contract);
if (!contract.utilityPolicy) throw new Error('utilityPolicy required');
if (!['development', 'confirmation'].includes(packet.phase)) throw new Error('phase required');
const decision = decideRetention(contract, packet.base, packet.candidate);
const comparison = compareUtility(contract.utilityPolicy, packet.base, packet.candidate.measures);
// Never infer successful confirmation from feasibility, a low proxy, or a retained proposal.
const stop = evaluateStop(packet.stopPolicy, {
  ...packet.resources,
  targetVerified: false,
  completed: [{ ...comparison, eligible: decision.status !== 'ineligible' && comparison.eligible }],
});
const result = {
  inputSha256: createHash('sha256').update(bytes).digest('hex'),
  contractId: contract.id, phase: packet.phase, decision, comparison, stop,
  targetStatus: 'UNVERIFIED',
  frameworkComparison: packet.frameworkTrials
    ? compareFramework(contract.utilityPolicy, packet.frameworkTrials.base, packet.frameworkTrials.candidate)
    : { status: 'incomparable', reason: 'framework-trials-not-supplied' },
  note: 'Single-comparison evaluator; confirmation and full campaign history require an independently bound runner. Retained means development proposal only.',
};
// Exclusive directory prevents overwriting prior evidence; source bytes survive parsing unchanged.
mkdirSync(output);
writeFileSync(join(output, 'input.json'), bytes, { flag: 'wx' });
writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result));
