#!/usr/bin/env node
// Re-render saved author outputs through the current producer. No models or delivery.
// Usage: node scripts/flash-render-saved.mjs <steps.json> <new-output-dir>
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildView } from '../plugins/option-wizard/lib/render/index.js';

const [source, output] = process.argv.slice(2);
const repo = fileURLToPath(new URL('../', import.meta.url));
if (!source || !output) throw new Error('expected <steps.json> <new-output-dir>');
const bytes = readFileSync(source);
const evidence = JSON.parse(bytes);
if (!evidence.run?.runId || !Array.isArray(evidence.steps) || !evidence.view) throw new Error('not a completed saved run');
const local = join(dirname(source), 'tool-io');
const recordings = existsSync(local) ? local : evidence.run.toolIo;
const raw = readdirSync(recordings).sort().filter((name) => name.endsWith('.json.gz')).map((name) => {
  const record = JSON.parse(gunzipSync(readFileSync(join(recordings, name))).toString('utf8'));
  if (typeof record.raw !== 'string') return '';
  if (createHash('sha256').update(record.raw).digest('hex') !== record.rawSha256) throw new Error(`recording hash mismatch: ${name}`);
  return record.raw;
}).filter(Boolean);
const { parse } = createRequire(new URL('../packages/core/package.json', import.meta.url))('yaml');
const config = parse(readFileSync(new URL('../plugins/option-wizard/tenant.yaml', import.meta.url), 'utf8'));
const report = {
  runId: evidence.run.runId, tenant: evidence.run.tenant, phase: evidence.run.phase,
  day: evidence.run.day, mode: evidence.view.outcome === 'DEGRADED' ? 'tool-only' : 'model',
  outcome: evidence.view.outcome === 'FAILED' ? 'failed' : 'completed',
  providersLive: [], providersSkipped: [], gatesSkipped: [], delivery: [], toolsUnconfigured: [],
  steps: evidence.steps.map((step, index) => ({
    task: step.task, role: step.role, mode: step.mode, text: step.output,
    ...(index === 0 ? { toolOutputs: raw } : {}),
  })),
};
const view = buildView(report, config);
view.outcome = evidence.view.outcome;
// Saved evidence omits per-attempt gate status. Do not erase the original warning.
if (evidence.view.degradation) view.degradation = evidence.view.degradation;
const renderedFrom = {
  sourceSha256: createHash('sha256').update(bytes).digest('hex'),
  rendererCodeSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  rendererDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(),
  rendererBuildSha256: (() => {
    const root = join(repo, 'plugins/option-wizard/lib');
    const hash = createHash('sha256');
    for (const file of readdirSync(root, { recursive: true }).filter((f) => f.endsWith('.js')).sort()) {
      hash.update(file).update('\0').update(readFileSync(join(root, file)));
    }
    return hash.digest('hex');
  })(),
  renderedAt: new Date().toISOString(),
  note: 'Saved author outputs; current renderer only. No new model run, gate verdict or delivery.',
};
mkdirSync(output, { recursive: false });
writeFileSync(join(output, 'steps.json'), JSON.stringify({ ...evidence, view, renderedFrom }, null, 2) + '\n');
console.log(join(output, 'steps.json'));
