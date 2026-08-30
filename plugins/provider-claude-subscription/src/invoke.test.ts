import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { invokeClaude } from "./invoke.js";

function fakeClaude(envelope: object): { dir: string; capture: string } {
  const dir = mkdtempSync(join(tmpdir(), "helium-claude-bin-"));
  const capture = join(dir, "argv.txt");
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `printf '%s\\n' \"$@\" > \"${capture}\"`,
      `echo '${JSON.stringify(envelope)}'`,
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return { dir, capture };
}

describe("invokeClaude", () => {
  it("passes exact model and effort and retains the complete modelUsage map", async () => {
    const { dir, capture } = fakeClaude({
      type: "result",
      result: "CLAUDE_OK",
      is_error: false,
      modelUsage: {
        "claude-sonnet-5": { inputTokens: 12, outputTokens: 3 },
        "claude-haiku-4-5-20251001": { inputTokens: 2, outputTokens: 1 },
      },
    });
    const workspace = mkdtempSync(join(tmpdir(), "helium-claude-workspace-"));
    const out = await invokeClaude({
      model: "claude-sonnet-5",
      effort: "xhigh",
      prompt: "PROMPTBODY",
      cwd: workspace,
      maxTurns: 2,
      timeoutMs: 5_000,
      allowedTools: [],
      env: { PATH: dir },
    });
    const argv = readFileSync(capture, "utf8").trim().split("\n");
    expect(argv).toEqual(
      expect.arrayContaining([
        "--model",
        "claude-sonnet-5",
        "--effort",
        "xhigh",
      ]),
    );
    expect(out.runtimeSnapshot.modelUsage).toEqual({
      "claude-sonnet-5": { inputTokens: 12, outputTokens: 3 },
      "claude-haiku-4-5-20251001": { inputTokens: 2, outputTokens: 1 },
    });
  });

  it("omits effort for a target that has no native effort control", async () => {
    const { dir, capture } = fakeClaude({
      type: "result",
      result: "HAIKU_OK",
      is_error: false,
    });
    const workspace = mkdtempSync(join(tmpdir(), "helium-claude-workspace-"));
    await invokeClaude({
      model: "claude-haiku-4-5-20251001",
      prompt: "PROMPTBODY",
      cwd: workspace,
      maxTurns: 2,
      timeoutMs: 5_000,
      allowedTools: [],
      env: { PATH: dir },
    });
    const argv = readFileSync(capture, "utf8").trim().split("\n");
    expect(argv).toContain("--model");
    expect(argv).not.toContain("--effort");
  });
});
