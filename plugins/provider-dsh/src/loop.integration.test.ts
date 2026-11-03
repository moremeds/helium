import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditStore, CapabilityCatalog, loadTenants, type Provider } from "@helium/core";
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { afterEach, expect, it, vi } from "vitest";
import sandbox from "../../sandbox-worktree/src/sandbox.js";
import { runTenant, registerProviders } from "../../../packages/cli/src/runner.js";
import { evidencePath } from "../../../packages/cli/src/evidence.js";
import { CordisRunParentFactory, CordisSubagentRuntime, DshHost } from "./host.js";
import { createDshContext } from "./runtime.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
function repository() {
  const root = mkdtempSync(join(tmpdir(), "helium-loop-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, "README.md"), "before\n");
  writeFileSync(join(root, ".gitignore"), ".worktrees/\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "initial");
  return root;
}
afterEach(() => vi.unstubAllEnvs());

it.each(["merged", "dirty", "unmerged"])("worktree cleanup: %s", async (state) => {
  const root = repository();
  const handle = await sandbox.create({ kind: "worktree", runId: state, readRoots: [root], writeRoots: [] });
  if (state !== "merged") writeFileSync(join(handle.root, "README.md"), "after\n");
  if (state === "unmerged") {
    git(handle.root, "add", ".");
    git(handle.root, "commit", "-m", "change");
  }
  await sandbox.destroy(handle);
  expect(existsSync(handle.root)).toBe(state !== "merged");
  expect(handle.detail?.retainedReason).toBe(state === "merged" ? undefined : state);
});

it("runs the coding loop in a worktree with real tools and persists the structured result", async () => {
  const root = repository();
  const plugins = join(root, "plugins");
  mkdirSync(plugins);
  cpSync(new URL("../../helium-dev/", import.meta.url), join(plugins, "helium-dev"), { recursive: true });
  symlinkSync(new URL("../../sandbox-worktree/", import.meta.url).pathname, join(plugins, "sandbox-worktree"), "dir");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.HELIUM_FIXTURE_DIR + '/gh.json', JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), gh: process.env.GH_TOKEN, github: process.env.GITHUB_TOKEN }));
console.log('https://example.invalid/pr/1');
`, { mode: 0o755 });
  vi.stubEnv("PATH", bin + ":" + process.env.PATH);
  vi.stubEnv("HELIUM_FIXTURE_DIR", root);
  vi.stubEnv("GH_TOKEN", "fixture-secret");
  vi.stubEnv("GITHUB_TOKEN", "fixture-secret");
  const result = { state: "ready", summary: "Checked fixture edit", prUrl: "https://example.invalid/pr/1" };
  const script = [
    ["bash", { description: "check cwd", command: 'pwd > "$HELIUM_FIXTURE_DIR/pwd.txt"' }],
    ["edit", { file_path: "README.md", old_string: "before", new_string: "after" }],
    ["bash", { description: "check and draft", command: 'test "$(cat README.md)" = after && git add README.md && git commit -m "fixture change" && gh pr create --draft --title fixture --body fixture' }],
    ["structured_output", result],
  ] as const;
  let turn = 0;
  class FakeLlm extends LlmAdapter {
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      expect(JSON.stringify(options.messages)).toContain("Check the [exit code: N] marker on every bash result");
      const [name, args] = script[turn++]!;
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield { type: "block-end", index: 0, block: { type: "tool-call", id: ToolCallId(`call-${turn}`), name, arguments: JSON.stringify(args) } };
      yield { type: "usage", usage: { inputTokens: 7, outputTokens: 2 } };
      yield { type: "finish", reason: { kind: "tool-calls" } };
    }
  }
  const ctx = await createDshContext({ sessionRoot: join(root, "sessions"), llmProvider: "unused", apiKeyEnv: "NO_SUCH_KEY" });
  ctx.llm.registerAdapter(["fake"], new FakeLlm());
  const host = new DshHost({ subagents: new CordisSubagentRuntime(ctx), parents: new CordisRunParentFactory(ctx), workspacesDir: join(root, "hosts"), maxDepth: 1 });
  const caps = ["code.edit", "tool.use", "structured.output"];
  const provider: Provider = {
    id: "fake", supportsMutations: true, capabilities: caps, models: [{ id: "simulation", caps, usdIn: 0, usdOut: 0 }], overheadTokens: 0,
    probe: async () => true,
    select: () => ({ targetId: "fake:simulation" as never, model: "simulation", options: { providerName: "spawn", provider: "fake" } }),
    run: (work, selection, signal) => host.run("loop", work, selection, signal),
  };
  const catalog = new CapabilityCatalog();
  registerProviders(catalog, [provider]);
  const audit = new AuditStore(":memory:");
  const loaded = loadTenants(plugins);
  expect(loaded.skipped).toEqual([]);
  const tenant = loaded.tenants[0]!;
  try {
    const report = await runTenant({ tenant, audit, catalog, providers: [provider], pluginsDir: plugins, stateRoot: join(root, "state"), runId: "loop" });
    expect(report.outcome, JSON.stringify(report)).toBe("completed");
    const cleanup = JSON.parse(readFileSync(join(root, "state/runs/loop/sandbox.json"), "utf8"));
    expect(readFileSync(join(root, "pwd.txt"), "utf8").trim()).toBe(cleanup.root);
    expect(readFileSync(join(cleanup.root, "README.md"), "utf8")).toBe("after\n");
    expect(JSON.parse(readFileSync(join(root, "gh.json"), "utf8"))).toEqual({ cwd: cleanup.root, argv: ["pr", "create", "--draft", "--title", "fixture", "--body", "fixture"] });
    expect(git(cleanup.root, "status", "--porcelain")).toBe("");
    expect(cleanup.detail.retainedReason).toBe("unmerged");
    expect(report.outcome).toBe("completed");
    expect(JSON.parse(report.steps[0]!.text)).toEqual(result);
    expect(readFileSync(evidencePath(join(root, "state"), "helium-dev", report.day, report.phase, report.runId), "utf8")).toContain(result.summary);
    expect(turn).toBe(4);
    tenant.manifest.roles.coder!.sandbox = "none";
    await expect(runTenant({ tenant, audit, catalog, providers: [provider], pluginsDir: plugins, stateRoot: join(root, "state") })).rejects.toThrow(/role sandbox override/);
  } finally {
    await host.close("loop");
    expect(ctx.agents.list()).toEqual([]);
    await ctx.fiber.dispose();
    audit.close();
  }
});
