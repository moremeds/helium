import { canonicalJson, parseStrictJson } from "@helium/core";

export type RuntimeNewsPerStock = 1 | 2 | 3;

export interface OptionWizardRuntimeConfig {
  schemaVersion: "ow-runtime-v1";
  tenant: "option-wizard";
  phase: "premarket";
  config: {
    news: {
      global: 4;
      perStock: RuntimeNewsPerStock;
      stocks: 5;
    };
  };
}

function record(value: unknown, at: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${at} must be an object`);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(`${at} must be a plain object`);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  at: string,
): void {
  const expected = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor")
      throw new Error(`${at}.${key} is forbidden`);
    if (!expected.has(key)) throw new Error(`${at}.${key} is unknown`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) throw new Error(`${at}.${key} is required`);
  }
}

/** Validate the complete, resolved tenant payload stored on a run snapshot. */
export function parseRuntimeConfig(value: unknown): OptionWizardRuntimeConfig {
  canonicalJson(value);
  const root = record(value, "runtimeConfig");
  exactKeys(root, ["schemaVersion", "tenant", "phase", "config"], "runtimeConfig");
  if (root.schemaVersion !== "ow-runtime-v1")
    throw new Error('runtimeConfig.schemaVersion must be "ow-runtime-v1"');
  if (root.tenant !== "option-wizard")
    throw new Error('runtimeConfig.tenant must be "option-wizard"');
  if (root.phase !== "premarket")
    throw new Error('runtimeConfig.phase must be "premarket"');

  const config = record(root.config, "runtimeConfig.config");
  exactKeys(config, ["news"], "runtimeConfig.config");
  const news = record(config.news, "runtimeConfig.config.news");
  exactKeys(
    news,
    ["global", "perStock", "stocks"],
    "runtimeConfig.config.news",
  );
  if (news.global !== 4)
    throw new Error("runtimeConfig.config.news.global is protected and must be 4");
  if (news.perStock !== 1 && news.perStock !== 2 && news.perStock !== 3)
    throw new Error("runtimeConfig.config.news.perStock must be 1, 2, or 3");
  if (news.stocks !== 5)
    throw new Error("runtimeConfig.config.news.stocks is protected and must be 5");

  return {
    schemaVersion: "ow-runtime-v1",
    tenant: "option-wizard",
    phase: "premarket",
    config: {
      news: { global: 4, perStock: news.perStock, stocks: 5 },
    },
  };
}

/** Raw proposals must pass duplicate/prototype-key checks before JSON parsing. */
export function parseRuntimeConfigJson(raw: string): OptionWizardRuntimeConfig {
  return parseRuntimeConfig(parseStrictJson(raw));
}
