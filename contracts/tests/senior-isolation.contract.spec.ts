/**
 * Registers the senior lane against the shared execution-boundary conformance
 * suite. The subject is a thin adapter over the SAME two functions
 * `buildSeniorLane()` calls — `buildChildEnv()` then `runClaude()` — and
 * nothing else: a subject that composed its own argv would prove things about
 * the test, not about production.
 *
 * Non-live. `claude` resolves to the harness's fake binary because
 * `runClaude()` spawns with the environment it is handed, and the harness
 * narrows PATH to a directory containing only that shim. No real CLI, no
 * model, no token.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { buildChildEnv, runClaude } from "../../plugins/helium/src/claude.js";
import { runExecutionBoundaryConformance } from "../harness/execution-boundary.js";

/**
 * A throwaway secrets root that deliberately holds NO token file. `buildChildEnv`
 * tolerates a missing file, so the child gets no `CLAUDE_CODE_OAUTH_TOKEN` —
 * the production env builder is still the one under test, and no credential is
 * anywhere near this suite.
 */
const secretsRoot = mkdtempSync(join(tmpdir(), "helium-boundary-secrets-"));

runExecutionBoundaryConformance({
  name: "senior-lane-runClaude",
  // A separate OS process with its own cwd, process group and environment.
  // NOT "sandboxed": nothing confines its filesystem access, and the harness
  // would fail the declaration if it were raised.
  declaredIsolationClass: "process",
  async invoke(input) {
    const env = buildChildEnv(
      {
        claudeTokenFile: join(secretsRoot, "claude-token.env"),
        envFile: join(secretsRoot, "helium.env"),
        proxy: "http://127.0.0.1:1",
      },
      input.env,
    );
    return await runClaude({
      model: "claude-sonnet-5",
      effort: "high",
      prompt: input.prompt,
      cwd: input.expectedWorkspace,
      maxTurns: 1,
      timeoutMs: 30_000,
      allowedTools: input.allowedTools,
      mcpConfigPath: input.mcpConfigPath,
      env,
    });
  },
});

afterAll(() => {
  rmSync(secretsRoot, { recursive: true, force: true });
});
