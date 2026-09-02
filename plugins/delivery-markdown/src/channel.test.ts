import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import channel, { MarkdownChannel } from "./channel.js";

const payload = {
  tenant: "option-wizard",
  runId: "run-1",
  subject: "helium option-wizard 2026-09-02",
  body: "line one\nline two",
};
const now = (): Date => new Date("2026-09-02T12:00:00Z");

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
    const result = await new MarkdownChannel({ now, stateRoot }).deliver(payload, {});
    expect(result.state).toBe("sent");
    expect(isAbsolute(result.detail!)).toBe(true);
    const written = readFileSync(result.detail!, "utf8");
    expect(written).toContain("# helium option-wizard 2026-09-02");
    expect(written).toContain("line two");
    expect(written).not.toContain("```");
    expect(written).toContain("helium audit run-1");
  });

  it("puts the run id in the FILENAME so two runs in a day cannot overwrite", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-md-"));
    const channelUnderTest = new MarkdownChannel({ now, stateRoot });
    await channelUnderTest.deliver(payload, {});
    await channelUnderTest.deliver({ ...payload, runId: "run-2" }, {});
    expect(readdirSync(join(stateRoot, "reports")).sort()).toEqual([
      "option-wizard-2026-09-02-run-1.md",
      "option-wizard-2026-09-02-run-2.md",
    ]);
  });

  it("resolves a relative `dir` against the state root, not the cwd", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-md-"));
    const result = await new MarkdownChannel({ now, stateRoot }).deliver(payload, {
      dir: "reports/daily",
    });
    expect(result.detail).toBe(
      join(stateRoot, "reports/daily", "option-wizard-2026-09-02-run-1.md"),
    );
  });

  it("refuses a non-string `dir` rather than writing somewhere surprising", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-md-"));
    const result = await new MarkdownChannel({ now, stateRoot }).deliver(payload, { dir: 7 });
    expect(result).toEqual({ state: "failed", detail: "markdown channel `dir` must be a string" });
  });
});
