// Run after pnpm build: node --test scripts/flash-render-saved.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

test('saved rendering preserves outcomes, identifies its build, and exports the same view without delivery', () => {
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const sample = join(repo, 'docs/evidence/flash-samples/2026-09-06-weekly');
  const dir = mkdtempSync(join(tmpdir(), 'flash-render-test-'));
  try {
    const original = JSON.parse(readFileSync(join(sample, 'steps.json')));
    original.run.toolIo = join(sample, 'tool-io');
    for (const outcome of ['FAILED', 'DEGRADED']) {
      original.view.outcome = outcome;
      const source = join(dir, `${outcome}.json`), output = join(dir, outcome);
      writeFileSync(source, JSON.stringify(original));
      const script = join(repo, 'scripts/flash-render-saved.mjs');
      execFileSync(process.execPath, [script, source, output], { cwd: tmpdir() });
      const result = JSON.parse(readFileSync(join(output, 'steps.json')));
      assert.equal(result.view.outcome, outcome);
      assert.equal(result.renderedFrom.rendererCodeSha, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim());
      assert.match(result.renderedFrom.rendererBuildSha256, /^[a-f0-9]{64}$/);
      assert.notEqual(spawnSync(process.execPath, [script, source, output]).status, 0);
      const payload = join(dir, `${outcome}-payload.json`);
      execFileSync(process.execPath, [join(repo, 'scripts/flash-page-payload.mjs'), join(output, 'steps.json'), payload]);
      assert.deepEqual(JSON.parse(readFileSync(payload)).view, result.view);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
