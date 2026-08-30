import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { invokeCodex } from "./invoke.js";

function fakeCodex(): { dir: string; capture: string } {
  const dir = mkdtempSync(join(tmpdir(), "helium-codex-bin-"));
  const capture = join(dir, "argv.json");
  const bin = join(dir, "codex");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `printf '%s\\n' \"$@\" > \"${capture}\"`,
      `echo '{"type":"item.completed","item":{"type":"agent_message","text":"CODEX_OK"}}'`,
      `echo '{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":3}}'`,
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return { dir, capture };
}

describe("invokeCodex", () => {
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
});
