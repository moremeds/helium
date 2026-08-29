import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { WorkOrderSchema } from "@helium/core";
import { describe, expect, it } from "vitest";
import { adaptV1Job, restoreV1Job } from "../src/adapter.js";
import { parseJobYaml } from "../src/job.js";

const JOBS_DIR = fileURLToPath(new URL("../../../jobs", import.meta.url));
const shipped = readdirSync(JOBS_DIR)
  .filter((f) => f.endsWith(".yaml"))
  .sort();

const parse = (file: string) =>
  parseJobYaml(readFileSync(join(JOBS_DIR, file), "utf8"), file);

describe("adaptV1Job", () => {
  it("translates the shipped macro tenant into the model-blind shape", () => {
    const adapted = adaptV1Job(parse("macro-watch.yaml"));
    expect(adapted).toMatchObject({
      triggerCount: 4,
      triage: {
        taskClass: "legacy.triage",
        constraints: { mutations: "forbidden" },
      },
      escalation: { threshold: "material" },
      delivery: { jsonl: true },
    });
  });

  it("emits work orders the core schema accepts", () => {
    for (const file of shipped) {
      const adapted = adaptV1Job(parse(file));
      expect(() => WorkOrderSchema.parse(adapted.triage), file).not.toThrow();
      expect(() => WorkOrderSchema.parse(adapted.senior), file).not.toThrow();
    }
  });

  it("keeps every legacy exact-target hint outside the work order", () => {
    const adapted = adaptV1Job(parse("macro-watch.yaml"));
    expect(adapted.hints).toEqual([
      { source: "v1-compat", lane: "triage", engine: "deepseek", model: expect.any(String) },
      { source: "v1-compat", lane: "senior", engine: "claude-max" },
    ]);

    // The work orders themselves must carry no provider identity. The job's
    // own prompt is excluded from the scan: it is tenant content, and this
    // tenant's prompt legitimately contains the word "model" in the sentence
    // "IF YOU ARE THE TRIAGE MODEL". Scanning it would assert something about
    // the tenant's English, not about the adapter.
    for (const order of [adapted.triage, adapted.senior]) {
      const withoutPrompt = { ...order, inputs: { artifacts: order.inputs.artifacts } };
      const serialized = JSON.stringify(withoutPrompt).toLowerCase();
      for (const token of ["deepseek", "claude", "v1-compat", "engine", "model"]) {
        expect(serialized, `${order.id} leaks ${token}`).not.toContain(token);
      }
      // ...and the prompt is still carried, so the exclusion above cannot be
      // satisfied by dropping it.
      expect(order.inputs.prompt).toBeTruthy();
    }
  });

  it("declares the senior lane at a stronger isolation class than triage", () => {
    const adapted = adaptV1Job(parse("macro-watch.yaml"));
    expect(adapted.triage.constraints.minIsolationClass).toBe("in-process");
    expect(adapted.senior.constraints.minIsolationClass).toBe("process");
  });
});

describe("round trip", () => {
  // The golden compatibility proof. A one-way shape assertion would pass while
  // silently dropping a field; this cannot.
  it.each(shipped)("restores %s byte-for-byte", (file) => {
    const job = parse(file);
    expect(restoreV1Job(adaptV1Job(job))).toEqual(job);
  });

  it("covers every shipped tenant, and there is at least one", () => {
    expect(shipped.length).toBeGreaterThan(0);
  });

  it("refuses an adapted job whose lane hints were stripped", () => {
    const adapted = adaptV1Job(parse("macro-watch.yaml"));
    expect(() => restoreV1Job({ ...adapted, hints: [] })).toThrow(/missing a lane hint/);
  });
});
