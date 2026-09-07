/**
 * The model step is ceremonial: the experiment files, not the prompt, carry
 * the hypotheses (an earlier version inlined one experiment verbatim, which
 * went stale the moment a second file was added).
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TENANT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const team = readFileSync(join(TENANT_DIR, "team.yaml"), "utf8");

describe("helium-self team prompt", () => {
  it("names no model and no vendor", () => {
    expect(team).not.toMatch(/claude|codex|deepseek|gpt|haiku|sonnet|opus/i);
  });
});
