import { mkdtempSync, readFileSync, writeFileSync, cpSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadTenants, parseTeamYaml } from "@helium/core";
import { startTestDatabase } from "../../../plugins/runtime-control/tests/postgres.js";
import { buildTools } from "../../../plugins/option-wizard/tools/index.js";
import { OW_RUNTIME_DEFAULT } from "../../../plugins/option-wizard/runtime/index.js";
import { runRuntimePilot, type RuntimeInference } from "../src/runtime-pilot.js";
import { evidencePath } from "../src/evidence.js";
import { sha256, writeRecording } from "../src/tool-io.js";
import { loadSnapshotRecordings } from "../src/replay-strict.js";

import { createCodexEvaluation } from "../../../plugins/provider-codex-subscription/src/evaluation.js";

const suite = process.env.HELIUM_RUNTIME_PG_TEST === "1" ? describe : describe.skip;
suite("database-to-runner mechanism (synthetic source world, no live models)", () => {
  it("uses the active DB version in rebuilt news and downstream context, then rolls back", async () => {
    const db = await startTestDatabase();
    try {
      const fakeCurl = join(db.scratch, "offline-curl");
      writeFileSync(fakeCurl, `#!/bin/sh
cat >/dev/null
printf '%s\\n' 'data: {"type":"response.completed","response":{"model":"simulated","usage":null}}' '' 'HELIUM_STATUS:200'
`, { mode: 0o700 });
      vi.stubEnv("HELIUM_CURL_BIN", fakeCurl);
      const pluginsDir = resolve(import.meta.dirname, "../../../plugins");
      const original = loadTenants(pluginsDir).tenants.find(t => t.spec.tenant === "option-wizard")!;
      // A small deterministic DAG exercises the real tenant builder and runner;
      // it is deliberately not claimed as the production team's quality test.
      const tenant = { ...original, manifest: parseTeamYaml(`manifestVersion: '2'
name: runtime-mechanism
roles:
  frame: { requires: [], permissions: { tools: [ow_session_frame] } }
  reader: { requires: [], permissions: { tools: [] } }
tasks:
  - { id: frame, role: frame, requires: [], prompt: build }
  - { id: reader, role: reader, requires: [], dependsOn: [frame], prompt: inspect }
`) };
      const inputDir = mkdtempSync(join(tmpdir(), "helium-synthetic-world-"));
      const asOf = new Date("2026-09-09T13:07:00.000Z");
      let seq = 0;
      const replay = {
        has: () => true,
        lookup(tool: string, args: Record<string, unknown>): string {
          // Explicit simulation: no observed market prices, trades or volumes.
          let value: unknown = {};
          if (tool === "ow_argon_watchlist") value = { chains: [], ofInterest: ["EXAMPLE"], ivRank: {} };
          if (tool === "ow_event_day" || tool === "ow_premarket_movers") value = null;
          if (tool === "ow_tv_news") value = { rows: args.symbol === "NASDAQ:EXAMPLE"
            ? [1, 2, 3].map(n => ({ id: `synthetic-${n}`, title: `Synthetic headline ${n}`,
                published: asOf.toISOString(), provider: "synthetic fixture",
                link: `https://example.invalid/synthetic-${n}`,
                urgency: 2, related_symbols: "NASDAQ:EXAMPLE" })) : [] };
          const raw = JSON.stringify(value);
          writeRecording(inputDir, ++seq, { tool, args, at: asOf.toISOString(), raw,
            rawSha256: sha256(raw), rawBytes: Buffer.byteLength(raw), context: null });
          return raw;
        },
      };
      const frame = buildTools({ stateRoot: inputDir, env: {}, phase: "premarket", asOf,
        extensions: original.spec.extensions, replayMode: "snapshot-pipeline", recordings: replay })
        .find(t => t.name === "ow_session_frame")!;
      await frame.run({});
      const scope = { tenant: "option-wizard", phase: "premarket", kind: "product", environment: "test" as const };
      await db.admin.createVersion({ scope, id: "two", payload: OW_RUNTIME_DEFAULT });
      await db.admin.createVersion({ scope, id: "three", parentId: "two", payload: {
        ...OW_RUNTIME_DEFAULT, config: { news: { ...OW_RUNTIME_DEFAULT.config.news, perStock: 3 } },
      } });
      await db.admin.initialize({ scope, versionId: "two", expectedRevision: 0, operationId: "init", approval: "mechanism fixture only" });
      const run = () => runRuntimePilot({ tenant, pluginsDir, inputDir, asOf, phase: "premarket", connection: db.runnerConnection });
      const two = await run();
      expect(two.report.outcome).toBe("completed");
      expect(two.report.delivery).toEqual([]);
      const doc = (result: typeof two) => JSON.parse(readFileSync(evidencePath(result.stateRoot,
        "option-wizard", result.report.day, "premarket", result.attemptId), "utf8"));
      const before = doc(two);
      expect(before.run.runtimeSnapshot.configVersionId).toBe("two");
      expect(before.steps[1].assembledPrompt).not.toContain("Synthetic headline 3");
      await db.admin.activate({ scope, versionId: "three", expectedRevision: 1, operationId: "activate", approval: "test switch only" });
      const three = await run();
      expect(three.report.outcome).toBe("completed");
      expect(doc(three).steps[1].assembledPrompt).toContain("Synthetic headline 3");
      expect(doc(three).run.runtimeSnapshot.configHash).not.toBe(before.run.runtimeSnapshot.configHash);
      expect(doc(two)).toEqual(before);
      const saved = await db.runner.inspectAttempt(three.attemptId);
      expect(saved.status).toBe("SUCCEEDED");
      expect((saved.evidence as Record<string, unknown>).modelCalls).toBe(0);
      await db.admin.rollback({ scope, versionId: "two", expectedRevision: 2, operationId: "rollback", approval: "restore compatible baseline" });
      const rollback = await run();
      expect(doc(rollback).run.runtimeSnapshot.deploymentRevision).toBe(3);
      expect(doc(rollback).steps[1].assembledPrompt).not.toContain("Synthetic headline 3");
      const snapshot = JSON.parse(readFileSync(join(three.stateRoot, "snapshot.json"), "utf8"));
      expect((await db.runner.inspectAttempt(three.attemptId)).snapshot).toEqual(snapshot);
      expect(loadSnapshotRecordings(join(three.stateRoot, "inputs")).inputHash).toBe(snapshot.metadata.inputWorldHash);
      // M2 composition, still explicitly simulated: a provider receives the
      // rebuilt frame through the real runner; its request accounting is saved.
      const prompts: string[] = [];
      const inference: RuntimeInference = {
        targetId: "test:simulation", identity: { grade: "SIMULATED" }, artifactDirs: [],
        create: () => ({
          provider: { id: "test", capabilities: ["code.edit"], overheadTokens: 0,
            models: [{ id: "simulation", caps: ["code.edit"], usdIn: 0, usdOut: 0 }],
            probe: async () => true,
            select: () => ({ targetId: "test:simulation" as never, model: "simulation" }),
            run: async work => {
              prompts.push(work.inputs.prompt!);
              return { text: "Explicit simulated answer", events: [
                { type: "step/start", seq: 1, time: 1000, data: { turn: 1, step: 1 } },
                { type: "assistant/chunk", seq: 2, time: 1001, data: { turn: 1, step: 1,
                  chunk: { type: "usage", usage: { inputTokens: 3, outputTokens: 1 } } } },
              ] };
            },
          },
          summary: () => ({ mode: "SIMULATED", requestCount: prompts.length, unknown: false }),
        }),
      };
      const modelTenant = { ...tenant, manifest: parseTeamYaml(`manifestVersion: '2'
name: runtime-evaluation-test
roles:
  frame: { requires: [], permissions: { tools: [ow_session_frame] } }
  reader: { requires: [code.edit], permissions: { tools: [] } }
tasks:
  - { id: frame, role: frame, requires: [], prompt: build }
  - { id: reader, role: reader, requires: [code.edit], dependsOn: [frame], prompt: inspect }
`) };
      const evaluation = await runRuntimePilot({ tenant: modelTenant, pluginsDir, inputDir, asOf,
        phase: "premarket", connection: db.runnerConnection, inference,
        expectedInputHash: loadSnapshotRecordings(inputDir).inputHash });
      expect(evaluation.report.outcome).toBe("completed");
      expect(evaluation.report.steps[1]?.mode).toBe("model");
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("Synthetic headline 2");
      expect(prompts[0]).not.toContain("Synthetic headline 3");
      expect(evaluation.report.delivery).toEqual([]);
      const evalAttempt = await db.runner.inspectAttempt(evaluation.attemptId);
      expect(evalAttempt.evidence).toMatchObject({ inference: { requestCount: 1, mode: "SIMULATED" }, qualityEvaluated: false });
      await expect(runRuntimePilot({ tenant: modelTenant, pluginsDir, inputDir, asOf,
        phase: "premarket", connection: db.runnerConnection, inference,
        expectedInputHash: "wrong" })).rejects.toThrow("Frozen input changed");
      expect(prompts).toHaveLength(1);
      const brokenDir = mkdtempSync(join(tmpdir(), "helium-broken-world-"));
      cpSync(inputDir, brokenDir, { recursive: true });
      const name = readdirSync(brokenDir).find(n => n.includes("ow_argon_watchlist"))!;
      const record = JSON.parse(gunzipSync(readFileSync(join(brokenDir, name))).toString("utf8"));
      const raw = '{"chains":42,"ofInterest":[],"ivRank":{}}';
      writeRecording(brokenDir, parseInt(name, 10), { ...record, raw, rawSha256: sha256(raw), rawBytes: Buffer.byteLength(raw) });
      const failed = await runRuntimePilot({ tenant, pluginsDir, inputDir: brokenDir, asOf, phase: "premarket", connection: db.runnerConnection });
      expect(failed.report.outcome).toBe("failed");
      expect((await db.runner.inspectAttempt(failed.attemptId)).status).toBe("FAILED");
      const uncertain = await runRuntimePilot({ tenant: modelTenant, pluginsDir, inputDir, asOf,
        phase: "premarket", connection: db.runnerConnection, inference: {
          targetId: "codex-subscription:gpt-5.6-luna", identity: { grade: "SIMULATED_TRANSPORT" }, artifactDirs: [],
          create: root => {
            const adapter = createCodexEvaluation({ outputDir: join(root, "inference"), model: "gpt-5.6-luna",
              env: { CODEX_ACCESS_TOKEN: `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.sig` },
              limits: { maxRequests: 2, timeoutMs: 10_000, maxOutputTokens: 32, maxRequestBytes: 1_000_000 } });
            return { provider: adapter.provider, summary: () => ({ ...adapter.summary() }) };
          },
        } });
      expect(readdirSync(join(uncertain.stateRoot, "inference"))).toContain("request-1-response.json");
      const uncertainAttempt = await db.runner.inspectAttempt(uncertain.attemptId);
      expect(uncertainAttempt.status).toBe("UNKNOWN");
      expect(uncertainAttempt.evidence).toMatchObject({ cost: null, inference: { unknown: true } });
      await expect(run()).rejects.toThrow("Runtime pilot failed");
      writeFileSync(join(db.scratch, "mechanism-result.json"), JSON.stringify({
        fixture: "synthetic", two, three, rollback, failed, evaluation, uncertain, inputDir,
      }, null, 2));
    } finally { vi.unstubAllEnvs(); await db.stop(); }
  }, 60_000);
});
