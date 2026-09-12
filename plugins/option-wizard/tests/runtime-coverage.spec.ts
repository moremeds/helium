/** Simulated review records only; this suite reads no market data and calls no model. */
import { describe, expect, it } from "vitest";
import { measureRuntimeCoverage } from "../eval/runtime-coverage.js";

const HASH = "a".repeat(64);
const base = () => ({
  events: [
    { id: "event-a", evidenceRefs: ["source:a"] },
    { id: "event-b", evidenceRefs: ["source:b"] },
  ],
  finalArtifactHash: HASH,
  reviewer: { identity: "independent-reviewer", rubricHash: HASH },
  completed: true,
  reviews: [
    { eventId: "event-a", verdict: "addressed", finalSpanRefs: ["final:1"], sourceRefs: ["source:a"], criticalErrors: 0, adjudication: "resolved" },
    { eventId: "event-b", verdict: "not-addressed", finalSpanRefs: [], sourceRefs: ["source:b"], criticalErrors: 0, adjudication: "resolved" },
  ],
});

describe("runtime coverage measurement", () => {
  it("uses only the preregistered denominator and reports manual review counts", () => {
    expect(measureRuntimeCoverage(base())).toEqual({
      status: "measured", coverageFinal: 0.5, reviewed: 2, eligible: 2, diagnostics: [],
    });
  });

  it("rejects omitted, duplicate, or new event reviews", () => {
    const missing = base();
    missing.reviews.pop();
    expect(() => measureRuntimeCoverage(missing)).toThrow(/missing: event-b/);
    const duplicate = base();
    duplicate.reviews[1]!.eventId = "event-a";
    expect(() => measureRuntimeCoverage(duplicate)).toThrow(/must not repeat/);
    const added = base();
    added.reviews[1]!.eventId = "event-c";
    expect(() => measureRuntimeCoverage(added)).toThrow(/added: event-c/);
  });

  it("keeps an unknown or unadjudicated event incomplete rather than scoring it", () => {
    const unknown = base();
    unknown.reviews[1]!.verdict = "unknown";
    unknown.reviews[1]!.adjudication = "unknown";
    expect(measureRuntimeCoverage(unknown)).toEqual({
      status: "incomplete", coverageFinal: null, reviewed: 2, eligible: 2,
      diagnostics: ["adjudication-unknown"],
    });
  });

  it("retains critical errors as a diagnostic, never a promotion result", () => {
    const critical = base();
    critical.reviews[1]!.criticalErrors = 1;
    expect(measureRuntimeCoverage(critical)).toEqual({
      status: "measured", coverageFinal: 0.5, reviewed: 2, eligible: 2,
      diagnostics: ["critical-errors"],
    });
    const inconsistent = base();
    inconsistent.reviews[0]!.criticalErrors = 1;
    expect(() => measureRuntimeCoverage(inconsistent)).toThrow(/addressed review/);
  });

  it("makes an empty preregistered denominator N/A", () => {
    const empty = base();
    empty.events = [];
    empty.reviews = [];
    expect(measureRuntimeCoverage(empty)).toEqual({
      status: "measured", coverageFinal: null, reviewed: 0, eligible: 0, diagnostics: [],
    });
  });

  it("records a failed generation as zero coverage without inventing a review", () => {
    const failed = base();
    failed.completed = false;
    failed.finalArtifactHash = null;
    failed.reviewer = null;
    failed.reviews = [];
    expect(measureRuntimeCoverage(failed)).toEqual({
      status: "generation-failed", coverageFinal: 0, reviewed: 0, eligible: 2, diagnostics: [],
    });
    const invented = base();
    invented.completed = false;
    invented.finalArtifactHash = null;
    invented.reviewer = null;
    expect(() => measureRuntimeCoverage(invented)).toThrow(/must not carry invented reviews/);
  });
});
