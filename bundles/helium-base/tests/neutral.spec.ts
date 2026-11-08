import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// Doctrine 2: helium-base knows no business domain. Products live in bundles.
const BUSINESS = /\b(option|options|ticker|stock|equit(y|ies)|portfolio|position|trade|trading|premarket|intraday|earnings)\b/i;

it("helium-base source names no business domain", () => {
  const dir = join(import.meta.dirname, "../src");
  const hits = readdirSync(dir).flatMap((f) =>
    readFileSync(join(dir, f), "utf8")
      .split("\n")
      .map((line, i) => [`${f}:${i + 1}`, line] as const)
      .filter(([, line]) => BUSINESS.test(line)),
  );
  expect(hits).toEqual([]);
});
