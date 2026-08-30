import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROCESS_RECEIPT_FILE } from "@helium/provider-sdk/process-receipt";
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

function stubbornClaude(): { dir: string; ready: string } {
  const dir = mkdtempSync(join(tmpdir(), "helium-claude-stubborn-"));
  const ready = join(dir, "ready");
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      "trap '' TERM",
      'printf ready > "$HELIUM_PROVIDER_READY"',
      "while true; do /bin/sleep 1; done",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return { dir, ready };
}

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(existsSync(path)).toBe(true);
}

describe("invokeClaude", () => {
  it("returns a normalized provider error when the Claude executable is unavailable", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "helium-claude-workspace-"));
    const out = await invokeClaude({
      model: "claude-sonnet-5",
      effort: "high",
      prompt: "NO BINARY",
      cwd: workspace,
      maxTurns: 2,
      timeoutMs: 5_000,
      allowedTools: [],
      env: { PATH: mkdtempSync(join(tmpdir(), "helium-empty-path-")) },
    });
    expect(out).toMatchObject({ ok: false, classification: "error" });
  });

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

  it("escalates cancellation when the provider ignores TERM and clears its receipt", async () => {
    const { dir, ready } = stubbornClaude();
    const workspace = mkdtempSync(join(tmpdir(), "helium-claude-workspace-"));
    const controller = new AbortController();
    const pending = invokeClaude({
      model: "claude-sonnet-5",
      effort: "high",
      prompt: "WAIT",
      cwd: workspace,
      maxTurns: 2,
      timeoutMs: 30_000,
      allowedTools: [],
      env: { PATH: dir, HELIUM_PROVIDER_READY: ready },
      signal: controller.signal,
    });
    await waitFor(ready);
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      ok: false,
      classification: "cancelled",
    });
    expect(existsSync(join(workspace, PROCESS_RECEIPT_FILE))).toBe(false);
  }, 10_000);
});
