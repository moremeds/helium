import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import channel, { MarkdownChannel } from "./channel.js";

// 2026-09-02 is the day the runner resolved in the tenant's report zone. It is
// a payload field, not a clock: 2026-09-03T02:40+08:00 in the launcher's zone
// is still 2026-09-02 in America/New_York, and the file must say so.
const payload = {
  tenant: "option-wizard",
  runId: "run-1",
  subject: "helium option-wizard 2026-09-02",
  body: "line one\nline two",
  day: "2026-09-02",
};

describe("markdown channel", () => {
  it("is exported as an instance, which is what discovery imports", () => {
    // `export default MarkdownChannel` would satisfy `typeof x === "function"`
    // on the constructor and then fail on `.deliver`, and discovery would drop
    // the channel with "default export is not a Channel".
    expect(typeof channel.deliver).toBe("function");
    expect(channel.id).toBe("markdown");
  });

  it("stays on the machine, so the operator egress brake does not apply", () => {
    expect(channel.external).toBe(false);
  });

  it("writes the report and returns the path it wrote", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-md-"));
    const result = await new MarkdownChannel({ stateRoot }).deliver(payload, {});
    expect(result.state).toBe("sent");
    expect(isAbsolute(result.detail!)).toBe(true);
    const written = readFileSync(result.detail!, "utf8");
    expect(written).toContain("# helium option-wizard 2026-09-02");
    expect(written).toContain("line two");
    expect(written).not.toContain("```");
    expect(written).toContain("helium audit run-1");
  });

  it("names the file by PHASE, so a rerun of one phase corrects it in place", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-md-"));
    const channelUnderTest = new MarkdownChannel({ stateRoot });
    await channelUnderTest.deliver({ ...payload, phase: "premarket" }, {});
    await channelUnderTest.deliver({ ...payload, phase: "close", runId: "run-2" }, {});
    await channelUnderTest.deliver({ ...payload, phase: "premarket", runId: "run-3" }, {});
    expect(readdirSync(join(stateRoot, "reports")).sort()).toEqual([
      "option-wizard-2026-09-02-close.md",
      "option-wizard-2026-09-02-premarket.md",
    ]);
    expect(
      readFileSync(join(stateRoot, "reports", "option-wizard-2026-09-02-premarket.md"), "utf8"),
    ).toContain("run-3");
  });

  it("falls back to the run id when no phase is set", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-md-"));
    await new MarkdownChannel({ stateRoot }).deliver(payload, {});
    expect(readdirSync(join(stateRoot, "reports"))).toEqual([
      "option-wizard-2026-09-02-run-1.md",
    ]);
  });

  it("resolves a relative `dir` against the state root, not the cwd", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-md-"));
    const result = await new MarkdownChannel({ stateRoot }).deliver(payload, {
      dir: "reports/daily",
    });
    expect(result.detail).toBe(
      join(stateRoot, "reports/daily", "option-wizard-2026-09-02-run-1.md"),
    );
  });

  it("refuses a non-string `dir` rather than writing somewhere surprising", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-md-"));
    const result = await new MarkdownChannel({ stateRoot }).deliver(payload, { dir: 7 });
    expect(result).toEqual({ state: "failed", detail: "markdown channel `dir` must be a string" });
  });

  it("ignores `rendered` and keeps writing the transcript body", async () => {
    // The markdown file is the durable record. If it followed the email into
    // the rendered form, the run's own metadata would exist nowhere on disk.
    const dir = mkdtempSync(join(tmpdir(), "helium-md-"));
    const outcome = await new MarkdownChannel({ stateRoot: dir }).deliver(
      {
        tenant: "demo",
        runId: "r1",
        subject: "generic subject",
        body: "**Outcome:** completed, 4 steps.",
        day: "2026-09-02",
        rendered: { subject: "pretty", text: "pretty text", html: "<p>x</p>" },
      },
      {},
    );
    expect(outcome.state).toBe("sent");
    const written = readFileSync(String(outcome.detail), "utf8");
    expect(written).toContain("# generic subject");
    expect(written).toContain("**Outcome:** completed, 4 steps.");
    expect(written).not.toContain("pretty");
  });
});
