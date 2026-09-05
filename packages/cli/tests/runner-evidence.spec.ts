import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditStore } from "@helium/core";
import { runTenant } from "../src/runner.js";
import { evidencePath, type EvidenceDoc } from "../src/evidence.js";
import { tenantFixture } from "./fixtures/tenant.js";

describe("runner evidence", () => {
  it("writes a header naming the tool-io directory and the code sha", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-runner-ev-"));
    const audit = AuditStore.open({
      HELIUM_AUDIT_DB: join(stateRoot, "audit.db"),
    });
    const report = await runTenant({ ...tenantFixture(stateRoot), audit });
    const doc = JSON.parse(
      readFileSync(
        evidencePath(
          stateRoot,
          "fake-tenant",
          report.day,
          report.phase,
          report.runId,
        ),
        "utf8",
      ),
    ) as EvidenceDoc;
    expect(doc.run.toolIo).toBe(
      join(stateRoot, "runs", report.runId, "tool-io") + "/",
    );
    expect(doc.run.deployment).toBe("test");
    expect(doc.run.codeSha.length).toBeGreaterThan(0);
    expect(doc.run.teamYamlSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.run.tenantYamlSha256).toMatch(/^[0-9a-f]{64}$/);
    audit.close();
  });

  it("assembledPrompt equals the string handed to the executor", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-runner-ev-"));
    const audit = AuditStore.open({
      HELIUM_AUDIT_DB: join(stateRoot, "audit.db"),
    });
    const seen: string[] = [];
    // The provider/executor stub shape is `runner-phase.spec.ts`'s, not an
    // invented one: a second shape for the same seam is a second thing to keep
    // in step.
    const report = await runTenant({
      ...tenantFixture(stateRoot),
      audit,
      providers: [
        {
          id: "recorder",
          capabilities: ["tool.use", "cheap.bulk", "structured.output"],
          overheadTokens: 0,
          models: [
            {
              id: "cheap",
              caps: ["tool.use", "cheap.bulk", "structured.output"],
              usdIn: 1e-6,
              usdOut: 2e-6,
            },
          ],
          async probe() {
            return true;
          },
          select() {
            return { targetId: "recorder:cheap" as never, model: "cheap" };
          },
        } as never,
      ],
      modelExecutor: {
        async run(work) {
          seen.push(work.inputs.prompt);
          return { text: "ok", events: [] };
        },
      },
    });
    const doc = JSON.parse(
      readFileSync(
        evidencePath(
          stateRoot,
          "fake-tenant",
          report.day,
          report.phase,
          report.runId,
        ),
        "utf8",
      ),
    ) as EvidenceDoc;
    expect(doc.steps.length).toBeGreaterThan(0);
    expect(seen).toContain(doc.steps[0]!.assembledPrompt);
    audit.close();
  });
});
