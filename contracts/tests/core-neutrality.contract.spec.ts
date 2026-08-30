/**
 * Core neutrality: `packages/core/src` may not name a provider or a business
 * domain. Acceptance criterion 14 — component and SOP plugins install without
 * adding domain names to core — is unsatisfiable while core knows what
 * `argon` or `deepseek` is.
 *
 * The two word lists below are **the single definition**. Every gate that
 * checks neutrality invokes this test; a gate that restates a pattern of its
 * own is a second list, and disagreeing lists are how a provider name in
 * `mcp/server.ts` survived four reviewers.
 * @module contracts/core-neutrality
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Bare `claude` is deliberate and is not a typo for `claude-max`. `claude-max`
 * is a v1 job-spec string literal that Task 6 removes from core, so a guard
 * keyed to it matches nothing under `packages/core/src` forever after — a
 * permanently-green assertion — while `claude-subscription`, `runClaude`, and
 * `claude -p` all walk straight past it.
 */
export const FORBIDDEN_PROVIDER_WORDS = [
  "deepseek",
  "claude",
  "anthropic",
  "codex",
  "openai",
  "gpt-",
  "gemini",
] as const;

export const FORBIDDEN_DOMAIN_WORDS = [
  "livewire",
  "argon",
  "apex",
  "colima",
  "postgres",
] as const;

const CORE_SRC = new URL("../../packages/core/src", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return path.endsWith(".ts") ? [path] : [];
    });
}

/**
 * Match on word boundaries over camelCase-split identifiers, never as a raw
 * substring. `apex` must not fire on `apexes`, while `runClaude` splits to
 * `run` + `claude` and fails. A trailing hyphen in a listed word (`gpt-`) is
 * a prefix marker, not a literal: the boundary form already catches `gpt-5`.
 *
 * A boundary-anchored pattern is a matching rule, not an allow-list. There is
 * no file allow-list and no comment exemption — the scan reads whole files,
 * documentation comments included.
 */
function wordPattern(word: string): RegExp {
  const bare = word.replace(/-$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${bare}\\b`);
}

/** Every `<file>: <word>` violation under `dir`, in file then list order. */
export function neutralityViolations(dir: string): string[] {
  const words = [...FORBIDDEN_PROVIDER_WORDS, ...FORBIDDEN_DOMAIN_WORDS];
  const found: string[] = [];
  for (const file of sourceFiles(dir)) {
    const split = readFileSync(file, "utf8")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase();
    for (const word of words) {
      if (wordPattern(word).test(split)) {
        found.push(`${relative(dir, file)}: ${word}`);
      }
    }
  }
  return found;
}

describe("core neutrality", () => {
  it("names no provider and no business domain under packages/core/src", () => {
    expect(neutralityViolations(CORE_SRC)).toEqual([]);
  });

  it("scans a non-empty file set", () => {
    // A guard that goes green because it found nothing to read is the failure
    // mode this contract exists to prevent.
    expect(sourceFiles(CORE_SRC).length).toBeGreaterThan(5);
  });

  it("matches on word boundaries, not raw substrings", () => {
    // Locks the matching rule itself: `apexes` must not fire, `runClaude` must.
    expect(wordPattern("apex").test("apexes")).toBe(false);
    expect(
      wordPattern("claude").test("run claude".toLowerCase()),
    ).toBe(true);
    expect(wordPattern("gpt-").test("gpt-5")).toBe(true);
  });

  it("guards every live provider family at the core boundary", () => {
    expect(FORBIDDEN_PROVIDER_WORDS).toEqual(
      expect.arrayContaining(["deepseek", "codex", "openai", "claude", "anthropic"]),
    );
  });
});
