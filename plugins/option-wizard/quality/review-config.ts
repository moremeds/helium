/**
 * The `extensions.review` declaration, parsed once and refused loudly.
 *
 * This module is the whole declarative surface of the review framework: the
 * coverage list, the sector chains, the verdict vocabulary, the word caps, the
 * focus weights and windows, the theme register and the rotation set. It is
 * read ONLY by this tenant (doctrine 2 — the host carries `extensions:` and
 * never opens it), and it has no clock, no filesystem and no network.
 *
 * A malformed block THROWS. `buildTools` calls this at the top, so a bad
 * declaration skips exactly this tenant with a recorded reason (AGENTS.md,
 * Architecture: "a throwing tool module ... skips exactly that tenant with a
 * recorded reason"). That is why there is no new validation seam and no core
 * edit here: the tenant-skip path already existed and this rides it.
 */
import { z } from "zod";

/**
 * The eight event kinds a focus row can be scored from. Declared HERE rather
 * than in `quality/focus.ts` because the loader has to validate
 * `focus.weights` and `focus.calendarPins[].kind` against it, and the loader
 * must not import the scorer (the scorer imports the config, not the other way
 * round).
 */
export const FOCUS_KINDS = [
  "earnings",
  "corporate",
  "macroNamed",
  "openCall",
  "theme",
  "flowAnomaly",
  "pinned",
  "assignmentRisk",
] as const;
export type FocusKind = (typeof FOCUS_KINDS)[number];

export interface ThemeEvidence {
  text: string;
  tool?: string;
}

export interface ThemeSpec {
  id: string;
  thesis: string;
  horizon: string;
  entered: string;
  instruments: string[];
  evidence: ThemeEvidence[];
  kill: string;
  killExcess?: { pct: number; sessions: number };
}

export interface FocusConfig {
  weekly: number;
  daily: number;
  weights: Record<FocusKind, number>;
  windows: {
    earnings: number;
    corporate: number;
    macroNamed: number;
    openCall: number;
    /** Declared in `tenant.yaml`; the plan's interface predates §I.1. */
    assignmentRisk: number;
  };
  tieBreak: readonly ["score", "daysToNearestEvent", "ticker"];
  maxEarningsLookups: number;
  maxIvTermCalls: number;
  calendarPins: Array<{
    ticker: string;
    day: string;
    kind: FocusKind;
    label: string;
  }>;
}

export interface RotationConfig {
  benchmark: string;
  lookbacks: { w1: number; w4: number; w12: number };
  sectorEtfs: string[];
}

export interface Caps {
  review: number;
  outlook: number;
  catalysts: number;
  rowWords: number;
  focusWords: number;
  themeWords: number;
}

export interface ReviewConfig {
  windows: number[];
  coverage: string[];
  sectors: string[];
  verdicts: string[];
  caps: {
    weekly: Caps;
    daily: Caps;
    weeklyModelWords: number;
    dailyModelWords: number;
  };
  /** Absent when the tenant declared no `focus:` block. The renderer then
   *  prints `not declared` rather than omitting the section. */
  focus?: FocusConfig;
  themes: ThemeSpec[];
  /** Absent when the tenant declared no `rotation:` block. Same rule. */
  rotation?: RotationConfig;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
/** A theme id becomes a coverage row id and a commitment id fragment, so it is
 *  restricted to what both can carry unescaped. */
const THEME_ID = /^[a-z0-9][a-z0-9-]{2,63}$/u;

const CapsSchema = z.object({
  review: z.number().int().positive(),
  outlook: z.number().int().positive(),
  catalysts: z.number().int().positive(),
  rowWords: z.number().int().positive(),
  focusWords: z.number().int().positive(),
  themeWords: z.number().int().positive(),
});

const RotationSchema = z.object({
  benchmark: z.string().min(1),
  lookbacks: z.object({
    w1: z.number().int().positive(),
    w4: z.number().int().positive(),
    w12: z.number().int().positive(),
  }),
  sectorEtfs: z.array(z.string().min(1)),
});

function fail(message: string): never {
  throw new Error(message);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${path} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

/**
 * Themes are validated by hand rather than by a zod object, because the
 * refusal MESSAGE is the product here: it is what the host records as the skip
 * reason and what the operator reads. A zod issue path is not that sentence.
 */
function parseThemes(raw: unknown): ThemeSpec[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail("extensions.review.themes must be a list");
  const out: ThemeSpec[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const theme = asRecord(entry, `extensions.review.themes[${index}]`);
    const id = typeof theme.id === "string" ? theme.id : "";
    const at = `extensions.review.themes[${index}] ${id || "<no id>"}`;
    if (id === "") fail(`${at}: id is required`);
    if (!THEME_ID.test(id)) {
      fail(
        `${at}: id must match ${String(THEME_ID.source)} — it becomes a coverage row id and a commitment id fragment`,
      );
    }
    if (seen.has(id)) {
      fail(`${at}: duplicate theme id — the coverage row id would collide`);
    }
    seen.add(id);
    // balder's admission gate (§H.1): no kill, no theme. A theme with no kill
    // condition is a mood, and a mood cannot be settled.
    if (typeof theme.kill !== "string" || theme.kill.trim() === "") {
      fail(
        `${at}: kill is required — a theme with no kill condition is not a theme`,
      );
    }
    if (!Array.isArray(theme.evidence) || theme.evidence.length === 0) {
      fail(
        `${at}: evidence is required — a theme with nothing pollable cannot be checked`,
      );
    }
    if (typeof theme.thesis !== "string" || theme.thesis.trim() === "") {
      fail(`${at}: thesis is required`);
    }
    if (typeof theme.horizon !== "string" || theme.horizon.trim() === "") {
      fail(`${at}: horizon is required — an undated theme never expires`);
    }
    if (typeof theme.entered !== "string" || !DAY.test(theme.entered)) {
      fail(`${at}: entered is required and must be yyyy-mm-dd`);
    }
    if (!Array.isArray(theme.instruments) || theme.instruments.length === 0) {
      fail(
        `${at}: instruments is required — the excess-move basket has nothing to average`,
      );
    }
    const evidence: ThemeEvidence[] = theme.evidence.map((row, j) => {
      const item = asRecord(row, `${at}.evidence[${j}]`);
      if (typeof item.text !== "string" || item.text.trim() === "") {
        fail(`${at}.evidence[${j}]: text is required`);
      }
      return {
        text: item.text,
        ...(typeof item.tool === "string" ? { tool: item.tool } : {}),
      };
    });
    let killExcess: ThemeSpec["killExcess"];
    if (theme.killExcess !== undefined) {
      const ke = asRecord(theme.killExcess, `${at}.killExcess`);
      if (typeof ke.pct !== "number" || !Number.isFinite(ke.pct)) {
        fail(`${at}.killExcess.pct must be a finite number`);
      }
      if (typeof ke.sessions !== "number" || !Number.isInteger(ke.sessions)) {
        fail(`${at}.killExcess.sessions must be an integer`);
      }
      killExcess = { pct: ke.pct, sessions: ke.sessions };
    }
    out.push({
      id,
      thesis: theme.thesis,
      horizon: theme.horizon,
      entered: theme.entered,
      instruments: theme.instruments.map((s) => String(s)),
      evidence,
      kill: theme.kill,
      ...(killExcess === undefined ? {} : { killExcess }),
    });
  });
  return out;
}

function parseFocus(raw: unknown): FocusConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  const focus = asRecord(raw, "extensions.review.focus");
  const weekly = focus.weekly;
  const daily = focus.daily;
  if (typeof weekly !== "number" || !Number.isInteger(weekly)) {
    fail("extensions.review.focus.weekly must be an integer");
  }
  if (typeof daily !== "number" || !Number.isInteger(daily)) {
    fail("extensions.review.focus.daily must be an integer");
  }
  if (!(weekly >= daily && daily >= 1)) {
    fail("extensions.review.focus: weekly >= daily >= 1 is required");
  }
  const weightsRaw = asRecord(focus.weights, "extensions.review.focus.weights");
  const weights = {} as Record<FocusKind, number>;
  for (const kind of FOCUS_KINDS) {
    const value = weightsRaw[kind];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      fail(
        `extensions.review.focus.weights.${kind} must be a finite number >= 0`,
      );
    }
    weights[kind] = value;
  }
  const windowsRaw = asRecord(focus.windows, "extensions.review.focus.windows");
  const windowKeys = [
    "earnings",
    "corporate",
    "macroNamed",
    "openCall",
    "assignmentRisk",
  ] as const;
  const windows = {} as FocusConfig["windows"];
  for (const key of windowKeys) {
    const value = windowsRaw[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      fail(
        `extensions.review.focus.windows.${key} must be a positive integer of OPEN sessions`,
      );
    }
    windows[key] = value;
  }
  // A configurable tie-break is a configurable answer. The field exists to be
  // READ — it is what makes the 15 replayable — not to be varied.
  const tieBreak = focus.tieBreak;
  const expected = ["score", "daysToNearestEvent", "ticker"];
  if (
    !Array.isArray(tieBreak) ||
    tieBreak.length !== expected.length ||
    tieBreak.some((v, i) => v !== expected[i])
  ) {
    fail(
      `extensions.review.focus.tieBreak must be exactly ${JSON.stringify(expected)} — a configurable tie-break is a configurable answer`,
    );
  }
  const maxEarningsLookups = focus.maxEarningsLookups;
  const maxIvTermCalls = focus.maxIvTermCalls;
  for (const [name, value] of [
    ["maxEarningsLookups", maxEarningsLookups],
    ["maxIvTermCalls", maxIvTermCalls],
  ] as const) {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      fail(`extensions.review.focus.${name} must be a positive integer`);
    }
  }
  const pinsRaw = focus.calendarPins;
  if (pinsRaw !== undefined && pinsRaw !== null && !Array.isArray(pinsRaw)) {
    fail("extensions.review.focus.calendarPins must be a list");
  }
  const calendarPins: FocusConfig["calendarPins"] = (
    Array.isArray(pinsRaw) ? pinsRaw : []
  ).map((entry, index) => {
    const at = `extensions.review.focus.calendarPins[${index}]`;
    const pin = asRecord(entry, at);
    if (typeof pin.ticker !== "string" || pin.ticker.trim() === "") {
      fail(`${at}.ticker is required`);
    }
    // The format IS the contract: a date a localeCompare sorts wrongly is
    // worse than no pin at all.
    if (typeof pin.day !== "string" || !DAY.test(pin.day)) {
      fail(`${at}.day must be yyyy-mm-dd`);
    }
    if (
      typeof pin.kind !== "string" ||
      !(FOCUS_KINDS as readonly string[]).includes(pin.kind)
    ) {
      fail(`${at}.kind must be one of ${FOCUS_KINDS.join(", ")}`);
    }
    if (typeof pin.label !== "string" || pin.label.trim() === "") {
      fail(`${at}.label is required`);
    }
    return {
      ticker: pin.ticker,
      day: pin.day,
      kind: pin.kind as FocusKind,
      label: pin.label,
    };
  });
  return {
    weekly,
    daily,
    weights,
    windows,
    tieBreak: ["score", "daysToNearestEvent", "ticker"] as const,
    maxEarningsLookups: maxEarningsLookups as number,
    maxIvTermCalls: maxIvTermCalls as number,
    calendarPins,
  };
}

/** THROWS on a malformed block. `buildTools` calls it, so a bad declaration
 *  skips exactly this tenant with a recorded reason. */
export function parseReviewConfig(extensions: unknown): ReviewConfig {
  const root = asRecord(extensions ?? {}, "extensions");
  if (root.review === undefined || root.review === null) {
    fail("extensions.review is required and was not declared");
  }
  const review = asRecord(root.review, "extensions.review");

  const windows = z
    .array(z.number().int().positive().max(60))
    .min(1)
    .parse(review.windows);
  const coverage = z.array(z.string().min(1)).min(1).parse(review.coverage);
  const sectors = z.array(z.string().min(1)).parse(review.sectors ?? []);
  const verdicts = z.array(z.string().min(1)).min(1).parse(review.verdicts);

  const capsRaw = asRecord(review.caps, "extensions.review.caps");
  const caps = {
    weekly: CapsSchema.parse(capsRaw.weekly),
    daily: CapsSchema.parse(capsRaw.daily),
    weeklyModelWords: z.number().int().positive().parse(capsRaw.weeklyModelWords),
    dailyModelWords: z.number().int().positive().parse(capsRaw.dailyModelWords),
  };

  const themes = parseThemes(review.themes);
  const focus = parseFocus(review.focus);
  const rotation =
    review.rotation === undefined || review.rotation === null
      ? undefined
      : RotationSchema.parse(review.rotation);

  // A coverage row id that collides with a sector or theme row would make two
  // rows share one verdict commitment. Cheap to check once, here.
  const ids = new Set<string>();
  for (const id of [
    ...coverage,
    ...sectors.map((s) => `sector:${s}`),
    ...themes.map((t) => `theme:${t.id}`),
  ]) {
    if (ids.has(id)) fail(`extensions.review: duplicate coverage row id ${id}`);
    ids.add(id);
  }

  return {
    windows,
    coverage,
    sectors,
    verdicts,
    caps,
    ...(focus === undefined ? {} : { focus }),
    themes,
    ...(rotation === undefined ? {} : { rotation }),
  };
}

/** The row ids the coverage table prints for the register: `theme:<id>`, in
 *  declared order, appended after the sector rows. */
export function themeRowIds(themes: readonly ThemeSpec[]): string[] {
  return themes.map((theme) => `theme:${theme.id}`);
}

/** The ONE place the row count is computed. Every test and every renderer asks
 *  HERE rather than writing a constant, so adding a theme is a yaml edit and
 *  nothing else. */
export function coverageRowCount(cfg: ReviewConfig): number {
  return cfg.coverage.length + cfg.sectors.length + cfg.themes.length;
}
