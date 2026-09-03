/**
 * The output-size seam, which had no caller at all until `Provider.run`
 * installed it: `applyOutputPolicy` was reachable code with a dead installer,
 * so a 50 KB report went into a context whole on 2026-09-02.
 *
 * Spill, not summarise: the full bytes go to disk and the head plus the path
 * enter the context. No second model call, so the fix cannot cost tokens.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { installHeliumHooks } from "./hooks.js";

const ROOT = mkdtempSync(join(tmpdir(), "helium-spill-"));

type Handler = (...args: never[]) => unknown;

function harness() {
  const handlers = new Map<string, Handler>();
  const ctx = {
    on: (event: string, fn: Handler) => {
      handlers.set(event, fn);
      return () => handlers.delete(event);
    },
  } as unknown as Context;
  const written: string[] = [];
  const dispose = installHeliumHooks(ctx, {
    runId: "run-1",
    role: "prober",
    spill: (bytes: string) => {
      const path = join(ROOT, `spill-${String(written.length)}.txt`);
      written.push(path);
      // Written with the same call the provider uses; reading it back is the
      // assertion that the FULL output survived.
      writeFileSync(path, bytes, "utf8");
      return path;
    },
  });
  const post = handlers.get("tools/post-execute");
  const run = async (text: string) =>
    (await (
      post as unknown as (
        exec: unknown,
        result: unknown,
        next: () => Promise<unknown>,
      ) => Promise<{ content: Array<{ text: string }> }>
    )(
      { name: "probe" },
      { isError: false, content: [{ type: "text", text }] },
      async () => ({ kind: "accept", content: [{ type: "text", text }] }),
    )) as { kind: string; content: Array<{ type: string; text: string }> };
  return { handlers, run, written, dispose };
}

describe("tool output policy", () => {
  it("spills an oversized result and hands back the head, the size and the path", async () => {
    const { run, written } = harness();
    const big = "y".repeat(20 * 1024);
    const decision = await run(big);
    const text = decision.content[0]!.text;
    expect(written).toHaveLength(1);
    expect(readFileSync(written[0]!, "utf8")).toBe(big);
    expect(text).toContain(written[0]!);
    expect(text).toContain(String(20 * 1024));
    // The head is a fixed-offset cut, and the notice says so — a reader that
    // took it for the whole answer would answer from half a record.
    expect(text).toContain("HEAD ONLY");
    expect(text.length).toBeLessThan(big.length);
  });

  it("leaves a result under the ceiling exactly as the tool wrote it", async () => {
    const { run, written } = harness();
    const small = "z".repeat(1024);
    expect((await run(small)).content[0]!.text).toBe(small);
    expect(written).toEqual([]);
  });

  it("installs no budget seams when it was given no budget to speak for", () => {
    // The provider has no audit store, and a budget line invented here would be
    // a number in a prompt that nothing measured.
    const { handlers } = harness();
    expect([...handlers.keys()].sort()).toEqual([
      "tools/post-execute",
      "tools/pre-execute",
    ]);
  });
});
