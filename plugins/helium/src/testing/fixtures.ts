/**
 * Shared `JobSpec`/`TriggerEvent` fixtures for the dispatch-lane test suites
 * (`dispatch.test.ts`, `dispatcher.test.ts`). One canonical job/event pair so
 * both suites exercise the same shape.
 * @module dsh-plugin-helium/testing/fixtures
 */
import type { JobSpec } from "@helium/core";
import type { TriggerEvent } from "../sensor.js";

export const job = {
  name: "macro-watch",
  enabled: true,
  triggers: [],
  engine: {
    triage: { engine: "deepseek", model: "deepseek-v4-flash" },
    senior: { engine: "claude-max" },
  },
  escalateWhen: "material",
  session: "fresh",
  memory: "thesis-file",
  tools: ["argon_api"],
  allowMutations: false,
  maxTurns: { triage: 2, senior: 8 },
  timeoutMs: 600_000,
  budget: { maxTriagePerHour: 30, maxSeniorPerDay: 12 },
  delivery: { jsonl: true },
  prompt: "Judge whether the macro state change matters.",
} as unknown as JobSpec;

export const ev: TriggerEvent = {
  job: "macro-watch",
  kind: "state-change",
  firedAt: "2026-08-23T12:00:00.000Z",
  dedupKey: "macro-watch:u:abc",
  payload: { previous: { s: "a" }, current: { s: "b" } },
};
