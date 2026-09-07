#!/usr/bin/env node
// Export the real channel payload for a saved run; the injected poster never sends.
// Usage: node scripts/flash-page-payload.mjs <steps.json> <new-output.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ArgonChannel } from '../plugins/delivery-argon/lib/channel.js';

const [source, output] = process.argv.slice(2);
if (!source || !output) throw new Error('expected <steps.json> <new-output.json>');
const evidence = JSON.parse(readFileSync(source, 'utf8'));
if (!evidence.run?.runId || !evidence.view?.schemaVersion) throw new Error('no final run/view in source');
const { parse } = createRequire(new URL('../packages/core/package.json', import.meta.url))('yaml');
const tenant = parse(readFileSync(new URL('../plugins/option-wizard/tenant.yaml', import.meta.url), 'utf8'));
const channel = new ArgonChannel({
  env: { ARGON_BASE_URL: 'http://fixture.invalid', ARGON_INGEST_TOKEN: 'local-fixture' },
  fetch: async (_url, init) => {
    writeFileSync(output, JSON.stringify(JSON.parse(init.body), null, 2) + '\n', { flag: 'wx' });
    return { status: 201 };
  },
});
const result = await channel.deliver({
  tenant: evidence.run.tenant, runId: evidence.run.runId,
  day: evidence.run.day, phase: evidence.run.phase, codeVersion: evidence.renderedFrom?.rendererCodeSha ?? evidence.run.codeSha,
  subject: '', body: '', rendered: { text: '', html: '', data: evidence.view },
}, tenant.delivery.find((entry) => entry.channel === 'argon').config);
if (result.state !== 'sent') throw new Error(JSON.stringify(result));
console.log(output);
