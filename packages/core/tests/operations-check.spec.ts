import { describe, expect, it } from "vitest";
import {
  CheckRegistry,
  evaluateCheck,
  type CheckDefinition,
} from "../src/operations/check.js";

const check = (overrides: Partial<CheckDefinition> = {}): CheckDefinition => ({
  id: "coverage-freshness",
  kind: "business",
  probe: { probeId: "fixture.coverage.v1", args: { window: "daily" } },
  expect: { dimension: "freshness", operator: "lte", value: 1 },
  onUnavailable: "unknown",
  timeoutMs: 30_000,
  owner: "operator",
  ...overrides,
});

const probes = ["fixture.coverage.v1", "fixture.liveness.v1"];

describe("CheckRegistry", () => {
  it("loads checks whose probes are registered", () => {
    const registry = CheckRegistry.load([check()], probes);
    expect(registry.get("coverage-freshness")?.kind).toBe("business");
  });

  it("refuses a check naming an unregistered probe", () => {
    expect(() =>
      CheckRegistry.load(
        [check({ probe: { probeId: "fixture.ghost.v1", args: {} } })],
        probes,
      ),
    ).toThrow(/fixture\.ghost\.v1/);
  });

  it("refuses a duplicate check id", () => {
    expect(() => CheckRegistry.load([check(), check()], probes)).toThrow(
      /duplicate check/,
    );
  });

  // A dangling CheckRef is the failure this registry exists to prevent: the
  // pre-action baseline must RUN every postcondition before the side effect,
  // so a postcondition cannot be an unresolved reference.
  it("refuses to resolve a reference it does not hold", () => {
    const registry = CheckRegistry.load([check()], probes);
    expect(() => registry.resolveAll(["coverage-freshness", "ghost-check"])).toThrow(
      /ghost-check/,
    );
  });

  it("resolves a reference set in the order given", () => {
    const registry = CheckRegistry.load(
      [check(), check({ id: "process-up", kind: "liveness" })],
      probes,
    );
    expect(registry.resolveAll(["process-up", "coverage-freshness"]).map((c) => c.id)).toEqual(
      ["process-up", "coverage-freshness"],
    );
  });

  it("rejects a free-form command anywhere in a check", () => {
    expect(() =>
      CheckRegistry.load(
        [{ ...check(), command: "psql -c 'select 1'" } as never],
        probes,
      ),
    ).toThrow();
  });
});

describe("evaluateCheck", () => {
  const definition = check();

  it("passes when the probe answers within the expectation", () => {
    expect(
      evaluateCheck(definition, {
        available: true,
        dimension: "freshness",
        value: 0,
      }),
    ).toBe("pass");
  });

  it("fails when the probe answers outside the expectation", () => {
    expect(
      evaluateCheck(definition, {
        available: true,
        dimension: "freshness",
        value: 4,
      }),
    ).toBe("fail");
  });

  // The single most important rule here. A check that cannot run has not
  // passed; treating unavailable as pass is how a postcondition set certifies
  // a repair that never happened.
  it("yields unknown when the probe cannot run, never pass", () => {
    expect(evaluateCheck(definition, { available: false })).toBe("unknown");
  });

  it("yields unknown when the probe answers a different dimension", () => {
    expect(
      evaluateCheck(definition, {
        available: true,
        dimension: "readiness",
        value: 0,
      }),
    ).toBe("unknown");
  });

  it("compares with data operators only, never an expression string", () => {
    const eq = check({ expect: { dimension: "d", operator: "eq", value: "up" } });
    expect(evaluateCheck(eq, { available: true, dimension: "d", value: "up" })).toBe("pass");
    expect(evaluateCheck(eq, { available: true, dimension: "d", value: "down" })).toBe("fail");

    const contains = check({
      expect: { dimension: "d", operator: "contains", value: "ok" },
    });
    expect(
      evaluateCheck(contains, { available: true, dimension: "d", value: "all ok now" }),
    ).toBe("pass");

    const gte = check({ expect: { dimension: "d", operator: "gte", value: 20 } });
    expect(evaluateCheck(gte, { available: true, dimension: "d", value: 20 })).toBe("pass");
    expect(evaluateCheck(gte, { available: true, dimension: "d", value: 19 })).toBe("fail");
  });

  it("yields unknown rather than guessing when the value type does not match", () => {
    const gte = check({ expect: { dimension: "d", operator: "gte", value: 20 } });
    expect(evaluateCheck(gte, { available: true, dimension: "d", value: "twenty" })).toBe(
      "unknown",
    );
  });
});
