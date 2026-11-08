/**
 * Real DSH, fake LLM: installs the `helium` profile into a throwaway
 * $DSH_HOME, then runs the smoke pipeline through `dsh --profile helium`.
 * Needs `pnpm build` (DSH loads lib/).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";

const repo = join(import.meta.dirname, "../../..");
const dsh = join(repo, "node_modules/.bin/dsh");
const home = mkdtempSync(join(tmpdir(), "helium-compose-"));
const patch = join(home, "fake.patch.yml");
const env = { ...process.env, DSH_HOME: home, HELIUM_STATE_ROOT: undefined, HELIUM_FAKE_MODE: undefined };

function run(args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync(dsh, ["--profile", "helium", "--patch", patch, ...args], {
    cwd: home,
    env: { ...env, ...extra },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status, err: r.stderr, out: r.stdout };
}

const db = () => new DatabaseSync(join(home, "helium/helium.sqlite"));

beforeAll(() => {
  execFileSync(join(repo, "scripts/install-profile.sh"), { env });
  writeFileSync(
    patch,
    `- insert:
    - { id: helium-fake-llm, name: helium-smoke/fake-llm }
- id: helium-runner
  config:
    models:
      reason.quick: { provider: fake, model: fake-quick }
      reason.deep: { provider: fake, model: fake-deep }
`,
  );
});

describe("smoke pipeline on real DSH", () => {
  it("runs analysts in parallel, judges from the menu, audits, enters and delivers", () => {
    const r = run(["run", "smoke", "--phase", "close", "--as-of", "2026-11-06"]);
    expect(r.code, r.err).toBe(0);

    // Tool scope: each role sees exactly its preset's tools, nothing from the host.
    const seen = [...r.err.matchAll(/\[fake\] model=(\S+) tools=(\S+)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(new Set(seen)).toEqual(
      new Set(['fake-quick ["smoke_quote","structured_output"]', 'fake-deep ["structured_output"]']),
    );
    // As-of: the model asked for 2099-12-31; the tool got the run's day.
    expect(r.err).toContain("date=2026-11-06 asOf=2026-11-06");
    expect(r.err).not.toContain("date=2099");

    const runId = (db().prepare("SELECT id FROM runs WHERE status = 'ok'").get() as { id: string }).id;
    const spans = db().prepare("SELECT role, label, model, input, cache_read, cache_write, context FROM spans WHERE run_id = ?").all(runId);
    expect(spans.map((s: any) => `${s.label} ${s.model}`).sort()).toEqual([
      "smoke-analyst:AAA fake-quick",
      "smoke-analyst:AAA fake-quick",
      "smoke-analyst:BBB fake-quick",
      "smoke-analyst:BBB fake-quick",
      "smoke-judge fake-deep",
    ]);
    expect(spans[0]).toMatchObject({ input: 100, cache_read: 7, cache_write: 3, context: 110 });

    expect(readFileSync(join(home, "helium/reports/smoke-2026-11-06-close.md"), "utf8")).toContain("Judge: **AAA**");
    expect(db().prepare("SELECT key, due FROM ledger WHERE run_id = ?").all(runId)).toEqual([{ key: "AAA", due: "2026-11-06" }]);

    const audit = run(["audit", runId]);
    expect(audit.code).toBe(0);
    expect(audit.out).toMatch(/^code: \S+/);
    expect(audit.out).toContain("smoke-judge");
  });

  it("settles the previous run's entry before the next run", () => {
    const r = run(["run", "smoke", "--phase", "close", "--as-of", "2026-11-09"]);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain("settled 1/1");
    const first = db().prepare("SELECT outcome FROM ledger WHERE due = '2026-11-06'").get() as { outcome: string };
    expect(JSON.parse(first.outcome)).toEqual({ settledOn: "2026-11-09" });
  });

  it("fails the run when an agent never submits structured output", () => {
    const r = run(["run", "smoke", "--as-of", "2026-11-09"], { HELIUM_FAKE_MODE: "noschema" });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/ended error without structured output/);
  });

  it("ends a hung run at the whole-run timeout", () => {
    const t = Date.now();
    const r = run(["run", "smoke", "--as-of", "2026-11-09", "--timeout", "2"], { HELIUM_FAKE_MODE: "hang" });
    expect(r.code).toBe(1);
    expect(Date.now() - t).toBeLessThan(20_000);
    expect((db().prepare("SELECT status FROM runs ORDER BY started_at DESC LIMIT 1").get() as { status: string }).status).toBe("timeout");
  });
});
