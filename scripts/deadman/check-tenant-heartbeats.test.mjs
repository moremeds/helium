// Local drill for check-tenant-heartbeats.mjs. No network, no SMTP, no daemon.
// Run with: node --test scripts/deadman/check-tenant-heartbeats.test.mjs
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "check-tenant-heartbeats.mjs");

const TENANT = (name, enabled = true) => `tenant: ${name}
enabled: ${enabled}
team: team.yaml
promotionMode: review-only
triggers:
  - kind: cron
    schedule: "0 17 * * 1-5"
    timezone: America/New_York
delivery:
  jsonl: true
`;

const TEAM = `manifestVersion: "1"
name: fixture
roles:
  scribe:
    responsibility: rendering
    requires: [render]
    permissions:
      externalResearch: false
      mutations: forbidden
      artifactRead: [accepted-claim-ledger]
      tools: []
tasks:
  - id: render
    role: scribe
    dependsOn: []
    requires: [render]
    inputs: [accepted-claim-ledger]
    outputSchema: report@1
crossReference:
  compareClaims: true
  materialContradictions: fresh-evidence-work-order
  requireIndependentEvidence: true
budgets: { maxAttempts: 1, maxTokens: 1000 }
acceptance: { allowPartialClaims: true, terminalTasks: [render] }
`;

/** One tenant DIRECTORY: `plugins/<name>/{tenant.yaml,team.yaml}`. */
function writeTenant(root, dirName, body) {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tenant.yaml"), body);
  writeFileSync(join(dir, "team.yaml"), TEAM);
}

/** A fixture fleet: `tenants` maps tenant -> heartbeat age in seconds, or null for none. */
function fixture(tenants, extraFiles = {}) {
  const root = mkdtempSync(join(tmpdir(), "helium-tenant-deadman-"));
  const tenantsDir = join(root, "plugins");
  const jsonlDir = join(root, "state", "jsonl");
  mkdirSync(tenantsDir, { recursive: true });
  mkdirSync(jsonlDir, { recursive: true });

  const rows = [];
  for (const [name, ageS] of Object.entries(tenants)) {
    writeTenant(tenantsDir, name, TENANT(name));
    if (ageS !== null) {
      rows.push(
        JSON.stringify({
          ts: new Date(Date.now() - ageS * 1000).toISOString(),
          job: name,
          status: "ok",
        }),
      );
    }
  }
  for (const [dirName, body] of Object.entries(extraFiles)) {
    writeTenant(tenantsDir, dirName, body);
  }
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(join(jsonlDir, `heartbeat-${day}.jsonl`), `${rows.join("\n")}\n`);

  return { root, tenantsDir, stateRoot: join(root, "state") };
}

function run({ tenantsDir, stateRoot }, staleS = "600") {
  const r = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      HELIUM_TENANTS_DIR: tenantsDir,
      HELIUM_STATE_ROOT: stateRoot,
      HELIUM_DEADMAN_STALE_S: staleS,
    },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("exits 0 when every enabled tenant has a current heartbeat", () => {
  const r = run(fixture({ "macro-watch": 60, "apex-health": 120 }));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /macro-watch/);
  assert.match(r.out, /apex-health/);
});

test("exits non-zero naming ONLY the stale tenant", () => {
  // The global dead-man check passes here: macro-watch is heartbeating, so the
  // newest row in the file is fresh. Only a per-tenant check catches apex-health.
  const r = run(fixture({ "macro-watch": 60, "apex-health": 3600 }));
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /apex-health/);
  const offending = r.out
    .split("\n")
    .filter((l) => /STALE|MISSING/i.test(l))
    .join("\n");
  assert.match(offending, /apex-health/);
  assert.doesNotMatch(
    offending,
    /macro-watch/,
    "a healthy tenant must never be named as the offender",
  );
});

test("a tenant that has never heartbeat at all is reported, not skipped", () => {
  const r = run(fixture({ "macro-watch": 60, "never-ran": null }));
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /never-ran/);
});

test("a future heartbeat cannot mask a dead tenant", () => {
  const r = run(fixture({ "future-watch": -3600 }));
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /future-watch/);
});

test("keeps a malformed tenant visible as invalid instead of dropping it", () => {
  const r = run(
    fixture({ "macro-watch": 60 }, { "b-broken": "tenant: [\n" }),
  );
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /b-broken/);
  assert.match(r.out, /invalid/i);
});

test("a disabled tenant is not required to heartbeat", () => {
  const f = fixture({ "macro-watch": 60 });
  writeTenant(f.tenantsDir, "paused", TENANT("paused", false));
  const r = run(f);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /paused/);
  assert.doesNotMatch(
    r.out.split("\n").filter((l) => /STALE|MISSING/i.test(l)).join("\n"),
    /paused/,
  );
});
