// Labeled synthetic metric values: no market data. Build helium-self before running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

test('CLI preserves input bytes, persists refusal/retention, never invents confirmation, refuses overwrite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helium-m3-utility-'));
  const packet = {
    contract: { id: 'synthetic-test', version: 'v1', goal: 'test comparator', evaluatorVersion: 'e1',
      rubricVersion: 'r1', holdoutVersion: 'h1', baseRevision: 'base', primaryMetric: 'reward', direction: 'higher',
      utilityPolicy: { constraint: { metric: 'loss', upperBound: 0.15 },
        objectives: [{ metric: 'reward', direction: 'higher', epsilon: 0.001 }] } },
    base: { loss: 0.2, reward: 0.3 },
    candidate: { id: 'c', parentRevision: 'base', revision: 'candidate', contractVersion: 'v1',
      measures: { loss: 0.1, reward: 0.2 },
      checks: { routeResolved: true, outputValid: true, evidenceComplete: true } },
    phase: 'development', stopPolicy: { maxCalls: 2, stalledCandidates: 3 },
    resources: { callsUsed: 2, elapsedMs: 10, targetVerified: true },
  };
  const input = join(dir, 'packet.json');
  const bytes = JSON.stringify(packet, null, 3) + '\n';
  writeFileSync(input, bytes);
  const run = (out) => spawnSync(process.execPath, ['scripts/research/evaluate-m3-campaign.mjs', input, out], { encoding: 'utf8' });
  const output = join(dir, 'result');
  assert.equal(run(output).status, 0);
  const result = JSON.parse(readFileSync(join(output, 'result.json'), 'utf8'));
  assert.equal(result.decision.status, 'retained');
  assert.equal(result.targetStatus, 'UNVERIFIED');
  assert.equal(result.stop.reason, 'budget_exhausted');
  assert.equal(result.inputSha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(readFileSync(join(output, 'input.json'), 'utf8'), bytes);
  assert.notEqual(run(output).status, 0);
  packet.candidate.checks.evidenceComplete = false;
  writeFileSync(input, JSON.stringify(packet));
  const refused = join(dir, 'refused');
  assert.equal(run(refused).status, 0);
  assert.equal(JSON.parse(readFileSync(join(refused, 'result.json'), 'utf8')).decision.status, 'ineligible');
});
