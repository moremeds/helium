/** Offline assertions for a completed real pilot; optional second run proves replay. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const [dir, replay] = process.argv.slice(2);
if (!dir) throw new Error('usage: node scripts/research/check-m3-pilot.mjs OUTPUT_DIR [PRIOR_OUTPUT_DIR]');
const read = (root, name) => JSON.parse(readFileSync(join(root,name),'utf8'));
const result=read(dir,'result.json'), summary=read(dir,'research/summary.json');
assert.equal(result.status,'PILOT_COMPLETED');
assert.equal(result.targetStatus,'UNVERIFIED');
assert.equal(summary.metric_basis,'realized_settlements_only');
assert.equal(summary.results.length,9);
assert.equal(result.retained,result.withinBudget && result.versusBaselineDecision.status==='retained' && result.versusControl.improved);
assert.equal(result.selected,result.retained?'candidate':'baseline');
const stages=readFileSync(join(dir,'events.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l).stage);
assert.deepEqual(stages,['diagnose','propose','execute-intent','verify','evaluate',result.retained?'retain-development-config':'rollback-to-baseline']);
if (replay) {
  const previous=read(replay,'research/summary.json');
  assert.equal(summary.snapshot_sha256,previous.snapshot_sha256);
  assert.deepEqual(summary.results,previous.results);
}
console.log('PASS: 9 scenarios, decision/lifecycle invariants, target unverified'+(replay?', identical replay results':''));
