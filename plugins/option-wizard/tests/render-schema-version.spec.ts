/**
 * The view carries its own version number.
 *
 * argon stores the document and renders it days later, from a build that may
 * be older than the one that wrote it. Without a version a renamed field shows
 * up there as a silently MISSING section — a shorter page, with no way for the
 * reader to know something was dropped. With one, the consumer says "I was
 * written for version N, this is N+1" and the fix is a deploy rather than an
 * investigation.
 *
 * The review JSON is one proposal lifted verbatim from the recorded premarket
 * run of 2026-09-03 (`run-9be0ec9f`): QQQ 716/722 bull call debit spread,
 * 2026-09-09 expiry, mids 5.29 / 2.50. No number here is invented.
 */
import { describe, expect, it } from "vitest";
import type { RunReport, TenantSpec } from "@helium/core";
import renderReport, {
  BRIEF_VIEW_SCHEMA_VERSION,
  buildView,
} from "../render/index.js";

const REVIEW_TEXT = `Keeping it.

\`\`\`json
{"proposals":[{"ticker":"QQQ","strategy":"bull call debit spread","legs":[{"right":"call","expiry":"2026-09-09","strike":716,"action":"buy","mid":5.29},{"right":"call","expiry":"2026-09-09","strike":722,"action":"sell","mid":2.5}],"entry":{"level":716,"side":"above"},"addLevel":715,"invalidation":[{"level":710,"side":"below"}],"target":722,"rationale":"Spot 716.50; long 716 is 0.07% ITM, short 722 is 0.77% OTM."}]}
\`\`\``;

const SPEC = { tenant: "option-wizard" } as unknown as TenantSpec;

function report(): RunReport {
  return {
    runId: "run-9be0ec9f-3070-4569-bfe1-ddf4956b3931",
    tenant: "option-wizard",
    phase: "premarket",
    day: "2026-09-03",
    mode: "model",
    providersLive: ["dsh"],
    providersSkipped: [],
    outcome: "completed",
    gatesSkipped: [],
    delivery: [],
    toolsUnconfigured: [],
    steps: [
      {
        task: "review",
        role: "risk-reviewer",
        mode: "model",
        text: REVIEW_TEXT,
      },
    ],
  } as unknown as RunReport;
}

describe("the brief view carries a schema version", () => {
  it("stamps every view with the current version", () => {
    expect(buildView(report(), SPEC).schemaVersion).toBe(
      BRIEF_VIEW_SCHEMA_VERSION,
    );
    expect(BRIEF_VIEW_SCHEMA_VERSION).toBe(1);
  });

  it("hands the structured document to the channels beside the prose", () => {
    const rendered = renderReport(report(), SPEC);
    expect(rendered.data?.date).toBe("2026-09-03");
    expect(rendered.data?.schemaVersion).toBe(1);
    // The slot is ADDITIVE: mail still gets exactly what it got before.
    expect(typeof rendered.text).toBe("string");
    expect(typeof rendered.html).toBe("string");
    // Still no subject — the runner is what knows the phase.
    expect(rendered.subject).toBeUndefined();
  });
});
