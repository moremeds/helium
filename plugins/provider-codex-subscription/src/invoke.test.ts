import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROCESS_RECEIPT_FILE } from "@helium/provider-sdk/process-receipt";
import { invokeCodex } from "./invoke.js";

function fakeCodex(message = "CODEX_OK"): { dir: string; capture: string } {
  const dir = mkdtempSync(join(tmpdir(), "helium-codex-bin-"));
  const capture = join(dir, "argv.json");
  const bin = join(dir, "codex");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `printf '%s\\n' \"$@\" > \"${capture}\"`,
      `echo '${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: message } })}'`,
      `echo '{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":3}}'`,
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return { dir, capture };
}

function stubbornCodex(): { dir: string; ready: string } {
  const dir = mkdtempSync(join(tmpdir(), "helium-codex-stubborn-"));
  const ready = join(dir, "ready");
  const bin = join(dir, "codex");
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

describe("invokeCodex", () => {
  it("returns a normalized provider error when the Codex executable is unavailable", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "helium-codex-workspace-"));
    const out = await invokeCodex({
      model: "gpt-5.6-sol",
      effort: "high",
      prompt: "NO BINARY",
      cwd: workspace,
      timeoutMs: 5_000,
      sandbox: "read-only",
      env: { PATH: mkdtempSync(join(tmpdir(), "helium-empty-path-")) },
      allowedTools: [],
    });
    expect(out).toMatchObject({ ok: false, classification: "error" });
  });

  it("invokes the exact native model and reasoning effort in an owned workspace", async () => {
    const { dir, capture } = fakeCodex();
    const workspace = mkdtempSync(join(tmpdir(), "helium-codex-workspace-"));
    const out = await invokeCodex({
      model: "gpt-5.6-sol",
      effort: "xhigh",
      prompt: "PROMPTBODY",
      cwd: workspace,
      timeoutMs: 5_000,
      sandbox: "read-only",
      env: { PATH: dir },
      allowedTools: [],
    });
    const argv = readFileSync(capture, "utf8").trim().split("\n");
    expect(argv).toEqual(
      expect.arrayContaining([
        "exec",
        "--model",
        "gpt-5.6-sol",
        "model_reasoning_effort=\"xhigh\"",
        "--cd",
        workspace,
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--ephemeral",
        "--json",
        "PROMPTBODY",
      ]),
    );
    expect(out.ok).toBe(true);
    expect(out.text).toBe("CODEX_OK");
    expect(out.runtimeSnapshot).toMatchObject({
      requestedModel: "gpt-5.6-sol",
      requestedEffort: "xhigh",
      effectiveEffort: "xhigh",
      usage: { inputTokens: 11, outputTokens: 3 },
    });
  });

  it("isolates settings and exposes only the declared MCP tools", async () => {
    const { dir, capture } = fakeCodex();
    const workspace = mkdtempSync(join(tmpdir(), "helium-codex-workspace-"));
    const mcpConfigPath = join(workspace, "mcp.json");
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          helium: {
            command: "/usr/bin/env",
            args: ["node", "server.mjs"],
            env: { HELIUM_SCOPE: "fixture" },
          },
        },
      }),
    );

    await invokeCodex({
      model: "gpt-5.6-sol",
      effort: "high",
      prompt: "BOUNDARY",
      cwd: workspace,
      timeoutMs: 5_000,
      sandbox: "read-only",
      env: { PATH: dir },
      allowedTools: ["mcp__helium__thesis_read"],
      mcpConfigPath,
    });

    const argv = readFileSync(capture, "utf8").trim().split("\n");
    expect(argv).toEqual(
      expect.arrayContaining([
        "--ignore-user-config",
        "--ignore-rules",
        "--strict-config",
        "features.shell_tool=false",
        "features.unified_exec=false",
        "tools.web_search=false",
        "features.multi_agent=false",
        'mcp_servers.helium.command="/usr/bin/env"',
        'mcp_servers.helium.args=["node","server.mjs"]',
        'mcp_servers.helium.env={ HELIUM_SCOPE = "fixture" }',
        'mcp_servers.helium.enabled_tools=["thesis_read"]',
        "mcp_servers.helium.required=true",
      ]),
    );
  });

  it("keeps every configured MCP server disabled when the tool list is empty", async () => {
    const { dir, capture } = fakeCodex();
    const workspace = mkdtempSync(join(tmpdir(), "helium-codex-workspace-"));
    const mcpConfigPath = join(workspace, "mcp.json");
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          helium: { command: "/usr/bin/env", args: ["node", "server.mjs"] },
        },
      }),
    );

    await invokeCodex({
      model: "gpt-5.6-sol",
      effort: "high",
      prompt: "BOUNDARY",
      cwd: workspace,
      timeoutMs: 5_000,
      sandbox: "read-only",
      env: { PATH: dir },
      allowedTools: [],
      mcpConfigPath,
    });

    const argv = readFileSync(capture, "utf8").trim().split("\n");
    expect(argv).toContain("mcp_servers.helium.enabled_tools=[]");
  });

  it("rejects a declared tool that is not addressed to a configured MCP server", async () => {
    const { dir } = fakeCodex();
    const workspace = mkdtempSync(join(tmpdir(), "helium-codex-workspace-"));
    const mcpConfigPath = join(workspace, "mcp.json");
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: { helium: { command: "/usr/bin/env" } },
      }),
    );

    await expect(
      invokeCodex({
        model: "gpt-5.6-sol",
        effort: "high",
        prompt: "BOUNDARY",
        cwd: workspace,
        timeoutMs: 5_000,
        sandbox: "read-only",
        env: { PATH: dir },
        allowedTools: ["mcp__other__undeclared"],
        mcpConfigPath,
      }),
    ).rejects.toThrow(/configured MCP server/i);
  });

  it("does not classify successful answer text about quotas as provider exhaustion", async () => {
    const { dir } = fakeCodex("The quota and rate-limit policy is documented here.");
    const workspace = mkdtempSync(join(tmpdir(), "helium-codex-workspace-"));
    const out = await invokeCodex({
      model: "gpt-5.6-sol",
      effort: "high",
      prompt: "EXPLAIN",
      cwd: workspace,
      timeoutMs: 5_000,
      sandbox: "read-only",
      env: { PATH: dir },
      allowedTools: [],
    });
    expect(out).toMatchObject({
      ok: true,
      text: "The quota and rate-limit policy is documented here.",
    });
  });

  it("escalates cancellation when the provider ignores TERM and clears its receipt", async () => {
    const { dir, ready } = stubbornCodex();
    const workspace = mkdtempSync(join(tmpdir(), "helium-codex-workspace-"));
    const controller = new AbortController();
    const pending = invokeCodex({
      model: "gpt-5.6-sol",
      effort: "high",
      prompt: "WAIT",
      cwd: workspace,
      timeoutMs: 30_000,
      sandbox: "read-only",
      env: { PATH: dir, HELIUM_PROVIDER_READY: ready },
      allowedTools: [],
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
