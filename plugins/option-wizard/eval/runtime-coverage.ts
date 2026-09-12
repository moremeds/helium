/**
 * Manual, tenant-owned measurement for the M2 premarket-news comparison.
 *
 * This accepts an independent review record, never a score claimed by the
 * article. It is diagnostic only: callers decide what to do with the result.
 */

export type CoverageVerdict = "addressed" | "not-addressed" | "unknown";
export type Adjudication = "resolved" | "unknown";

export interface PreregisteredEvent {
  id: string;
  evidenceRefs: string[];
}

export interface EventReview {
  eventId: string;
  verdict: CoverageVerdict;
  finalSpanRefs: string[];
  sourceRefs: string[];
  criticalErrors: number;
  adjudication: Adjudication;
}

export interface RuntimeCoverageRecord {
  events: PreregisteredEvent[];
  finalArtifactHash: string | null;
  reviewer: { identity: string; rubricHash: string } | null;
  /** False means generation failed before a review existed. */
  completed: boolean;
  reviews: EventReview[];
}

export interface RuntimeCoverageMeasurement {
  status: "measured" | "incomplete" | "generation-failed";
  coverageFinal: number | null;
  reviewed: number;
  eligible: number;
  diagnostics: Array<"critical-errors" | "adjudication-unknown">;
}

const HASH = /^[a-f0-9]{64}$/iu;

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0)
    throw new Error(`${name} has unsupported field(s): ${unexpected.join(", ")}`);
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be non-empty text`);
  return value;
}

function refs(value: unknown, name: string, required = true): string[] {
  if (!Array.isArray(value) || (required && value.length === 0) || value.some((entry) => typeof entry !== "string" || entry.trim() === ""))
    throw new Error(`${name} must be a${required ? " non-empty" : ""} text list`);
  if (new Set(value).size !== value.length) throw new Error(`${name} must not repeat references`);
  return value;
}

function hash(value: unknown, name: string): string {
  const result = text(value, name);
  if (!HASH.test(result)) throw new Error(`${name} must be a SHA-256 hash`);
  return result;
}

function parseEvent(value: unknown): PreregisteredEvent {
  const item = record(value, "event");
  exactKeys(item, ["id", "evidenceRefs"], "event");
  return { id: text(item.id, "event.id"), evidenceRefs: refs(item.evidenceRefs, "event.evidenceRefs") };
}

function parseReview(value: unknown): EventReview {
  const item = record(value, "review");
  exactKeys(item, ["eventId", "verdict", "finalSpanRefs", "sourceRefs", "criticalErrors", "adjudication"], "review");
  const verdict = item.verdict;
  const adjudication = item.adjudication;
  const criticalErrors = item.criticalErrors;
  if (verdict !== "addressed" && verdict !== "not-addressed" && verdict !== "unknown")
    throw new Error("review.verdict is invalid");
  if (adjudication !== "resolved" && adjudication !== "unknown")
    throw new Error("review.adjudication is invalid");
  if (typeof criticalErrors !== "number" || !Number.isSafeInteger(criticalErrors) || criticalErrors < 0)
    throw new Error("review.criticalErrors must be a non-negative integer");
  if (verdict === "addressed" && criticalErrors > 0)
    throw new Error("an addressed review cannot carry critical errors");
  const finalSpanRefs = refs(item.finalSpanRefs, "review.finalSpanRefs", false);
  if (verdict === "addressed" && finalSpanRefs.length === 0)
    throw new Error("an addressed review needs a final span reference");
  return {
    eventId: text(item.eventId, "review.eventId"), verdict,
    finalSpanRefs,
    sourceRefs: refs(item.sourceRefs, "review.sourceRefs"),
    criticalErrors, adjudication,
  };
}

function parse(input: unknown): RuntimeCoverageRecord {
  const value = record(input, "runtime coverage record");
  exactKeys(value, ["events", "finalArtifactHash", "reviewer", "completed", "reviews"], "runtime coverage record");
  if (!Array.isArray(value.events)) throw new Error("events must be a list");
  if (!Array.isArray(value.reviews)) throw new Error("reviews must be a list");
  if (typeof value.completed !== "boolean") throw new Error("completed must be boolean");
  const events = value.events.map(parseEvent);
  if (new Set(events.map((event) => event.id)).size !== events.length)
    throw new Error("events must not repeat ids");
  if (!value.completed) {
    if (value.finalArtifactHash !== null || value.reviewer !== null)
      throw new Error("failed generation must not claim an artifact or reviewer");
    return { events, finalArtifactHash: null, reviewer: null, completed: false, reviews: value.reviews.map(parseReview) };
  }
  const reviewer = record(value.reviewer, "reviewer");
  exactKeys(reviewer, ["identity", "rubricHash"], "reviewer");
  return {
    events, finalArtifactHash: hash(value.finalArtifactHash, "finalArtifactHash"),
    reviewer: { identity: text(reviewer.identity, "reviewer.identity"), rubricHash: hash(reviewer.rubricHash, "reviewer.rubricHash") },
    completed: true, reviews: value.reviews.map(parseReview),
  };
}

/** Measure the exact preregistered event denominator; never infer coverage from article text. */
export function measureRuntimeCoverage(input: unknown): RuntimeCoverageMeasurement {
  const record = parse(input);
  const eligible = record.events.length;
  if (!record.completed) {
    if (record.reviews.length !== 0) throw new Error("failed generation must not carry invented reviews");
    return { status: "generation-failed", coverageFinal: eligible === 0 ? null : 0, reviewed: 0, eligible, diagnostics: [] };
  }

  const expected = new Set(record.events.map((event) => event.id));
  const actual = record.reviews.map((review) => review.eventId);
  if (new Set(actual).size !== actual.length) throw new Error("reviews must not repeat event ids");
  const missing = [...expected].filter((id) => !actual.includes(id));
  const added = actual.filter((id) => !expected.has(id));
  if (missing.length > 0 || added.length > 0)
    throw new Error(`reviews must exactly match preregistered events (missing: ${missing.join(", ") || "none"}; added: ${added.join(", ") || "none"})`);
  if (eligible === 0)
    return { status: "measured", coverageFinal: null, reviewed: 0, eligible: 0, diagnostics: [] };

  const incomplete = record.reviews.some((review) => review.verdict === "unknown" || review.adjudication === "unknown");
  const diagnostics: RuntimeCoverageMeasurement["diagnostics"] = [];
  if (record.reviews.some((review) => review.criticalErrors > 0)) diagnostics.push("critical-errors");
  if (record.reviews.some((review) => review.adjudication === "unknown")) diagnostics.push("adjudication-unknown");
  return {
    status: incomplete ? "incomplete" : "measured",
    coverageFinal: incomplete ? null : record.reviews.filter((review) => review.verdict === "addressed").length / eligible,
    reviewed: record.reviews.length,
    eligible,
    diagnostics,
  };
}
