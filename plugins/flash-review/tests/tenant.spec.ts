import { gzipSync } from "node:zlib";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadTenants } from "@helium/core";
import {
  MAX_DATED_EVENTS,
  MAX_RAW_BYTES,
  VOCABULARY,
  buildTools,
  collateDatedEvents,
  datedEventsIn,
} from "../tools/index.js";

const PLUGINS = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** The real glob, over the real plugins directory. A tenant that fails to
 *  parse is SKIPPED with a reason rather than throwing, so asserting it is
 *  absent from `skipped` is the only check that can see a broken manifest. */
function loaded() {
  const result = loadTenants(PLUGINS);
  return {
    tenant: result.tenants.find((entry) => entry.spec.tenant === "flash-review"),
    skipped: result.skipped.filter((entry) => entry.tenant === "flash-review"),
  };
}

describe("flash-review tenant", () => {
  it("is discovered by the glob with no registry to edit", () => {
    const { tenant, skipped } = loaded();
    expect(skipped).toEqual([]);
    expect(tenant?.spec.enabled).toBe(true);
    // No trigger: this tenant runs only when a human names it.
    expect(tenant?.spec.triggers).toEqual([]);
    expect(tenant?.spec.env).toEqual(["FR_PAGE", "FR_EVIDENCE_DIR"]);
  });

  it("routes its one role by capability and never by model", () => {
    const { tenant } = loaded();
    const reviewer = tenant?.manifest.roles.reviewer;
    expect(reviewer?.requires).toEqual([
      "reason.deep",
      "long.context",
      "tool.use",
    ]);
    expect(JSON.stringify(tenant?.manifest)).not.toMatch(
      /claude|gpt|opus|sonnet|haiku|deepseek/iu,
    );
  });

  it("gives the reviewer only the three tools this tenant builds", () => {
    const { tenant } = loaded();
    const granted = tenant?.manifest.roles.reviewer?.permissions.tools ?? [];
    expect([...granted].sort()).toEqual([
      "fr_dated_events",
      "fr_evidence",
      "fr_page",
      "fr_rubric",
    ]);
    // A role naming a tool the tenant does not build skips the tenant at run
    // time, which is a failure nobody sees until the run. Catch it here.
    for (const name of granted) expect(VOCABULARY.has(name)).toBe(true);
  });
});

describe("fr_evidence", () => {
  /** One recording directory holding a `raw` deliberately larger than the
   *  window, so the cap is exercised rather than asserted about. */
  function sample(rawBytes: number): string {
    const dir = mkdtempSync(join(tmpdir(), "flash-review-evidence-"));
    const raw = "x".repeat(rawBytes);
    writeFileSync(
      join(dir, "00001-ow_probe.json.gz"),
      gzipSync(
        Buffer.from(
          JSON.stringify({
            tool: "ow_probe",
            args: {},
            at: "2026-09-06T21:28:34.311Z",
            raw,
            rawBytes,
          }),
        ),
      ),
    );
    return dir;
  }

  function tool(dir: string) {
    const built = buildTools({
      stateRoot: "/state",
      env: { FR_PAGE: "/dev/null", FR_EVIDENCE_DIR: dir },
    });
    const found = built.find((entry) => entry.name === "fr_evidence");
    if (found === undefined) throw new Error("fr_evidence was not built");
    return found;
  }

  it("caps one recording's raw at the byte window and says where to continue", async () => {
    const over = MAX_RAW_BYTES + 5_000;
    const parsed = JSON.parse(
      await tool(sample(over)).run({ file: "00001-ow_probe.json.gz" }),
    ) as {
      raw: string;
      rawBytes: number;
      offset: number;
      nextOffset?: number;
      truncated?: boolean;
    };
    expect(parsed.raw.length).toBe(MAX_RAW_BYTES);
    expect(parsed.rawBytes).toBe(over);
    expect(parsed.offset).toBe(0);
    expect(parsed.nextOffset).toBe(MAX_RAW_BYTES);
    expect(parsed.truncated).toBe(true);
  });

  it("serves the rest from the offset it named, and stops claiming truncation", async () => {
    const over = MAX_RAW_BYTES + 5_000;
    const parsed = JSON.parse(
      await tool(sample(over)).run({
        file: "00001-ow_probe.json.gz",
        offset: MAX_RAW_BYTES,
      }),
    ) as { raw: string; truncated?: boolean; nextOffset?: number };
    expect(parsed.raw.length).toBe(5_000);
    expect(parsed.truncated).toBeUndefined();
    expect(parsed.nextOffset).toBeUndefined();
  });

  it("returns a recording under the window whole", async () => {
    const parsed = JSON.parse(
      await tool(sample(100)).run({ file: "00001-ow_probe.json.gz" }),
    ) as { raw: string; truncated?: boolean };
    expect(parsed.raw.length).toBe(100);
    expect(parsed.truncated).toBeUndefined();
  });

  it("refuses a file name that is not a recording in this directory", async () => {
    await expect(
      tool(sample(100)).run({ file: "../../../etc/passwd" }),
    ).rejects.toThrow(/not a recording name/u);
  });
});

describe("fr_dated_events extractor", () => {
  /**
   * A verbatim slice of the real recording this tool exists because of:
   * `docs/evidence/flash-samples/2026-09-06-weekly/tool-io/00001-ow_session_frame.json.gz`,
   * around the FOMC row that three model-built enumerations all left out. Kept
   * character-for-character, with the recording's own `at`, so the fixture is
   * frozen observed data rather than an invented calendar.
   */
  const FROZEN: { tool: string; at: string; raw: string } = {
    tool: "ow_session_frame",
    at: "2026-09-06T21:26:55.079Z",
    raw:
      '{"time":"2026-09-10","type":"earnings","event":"ORCL earnings (post)",' +
      '"forecast":"implied move 9.8619%","session":"post"},' +
      '{"time":"2026-09-16","type":"policy path","event":"FOMC 9/16",' +
      '"forecast":"HIKE 55.7%","prev":"3.75-4.00%"},{"time":"2026-09-30",',
  };

  it("finds both spellings of the day the model-built lists kept dropping", () => {
    const found = datedEventsIn(FROZEN, "00001-ow_session_frame.json.gz");
    const sixteenth = found.filter((event) => event.date === "2026-09-16");
    // The ISO `"time":"2026-09-16"` and the prose `FOMC 9/16` are two tokens
    // for one day, and a page that writes only one of them is still a page
    // that names the event — which is why both are returned.
    expect(sixteenth.map((event) => event.token).sort()).toEqual([
      "2026-09-16",
      "9/16",
    ]);
    expect(sixteenth[0]?.tool).toBe("ow_session_frame");
    expect(sixteenth[0]?.file).toBe("00001-ow_session_frame.json.gz");
    expect(sixteenth.some((event) => event.snippet.includes("FOMC"))).toBe(true);
    for (const event of found) expect(event.snippet.length).toBeLessThanOrEqual(160);
  });

  it("takes a bare M/D's year from the recording's own timestamp", () => {
    const [nine] = datedEventsIn(
      { tool: "t", at: "2026-09-06T21:26:55.079Z", raw: "FOMC 9/16 is next" },
      "f.json",
    );
    expect(nine?.date).toBe("2026-09-16");
    // Undated recording, unresolvable M/D: dropped, never guessed into a year.
    expect(datedEventsIn({ tool: "t", raw: "FOMC 9/16 is next" }, "f.json")).toEqual([]);
  });

  it("keeps every dated form apart from a number that merely contains slashes", () => {
    const found = datedEventsIn(
      { tool: "t", at: "2026-09-06T00:00:00Z", raw: "flow 39758465 ratio 1/2/3/4 spread 3.75-4.00% day 13/45" },
      "f.json",
    );
    expect(found).toEqual([]);
  });

  it("deduplicates, orders by date and honours the window", () => {
    const twice = [
      ...datedEventsIn(FROZEN, "00001-ow_session_frame.json.gz"),
      ...datedEventsIn(FROZEN, "00001-ow_session_frame.json.gz"),
    ];
    const all = collateDatedEvents(twice, {});
    expect(all.events).toEqual(collateDatedEvents(
      datedEventsIn(FROZEN, "00001-ow_session_frame.json.gz"),
      {},
    ).events);
    expect(all.events.map((event) => event.date)).toEqual(
      [...all.events.map((event) => event.date)].sort(),
    );
    const windowed = collateDatedEvents(twice, {
      from: "2026-09-15",
      to: "2026-09-20",
    });
    expect([...new Set(windowed.events.map((event) => event.date))]).toEqual([
      "2026-09-16",
    ]);
  });

  it("keeps distinct same-day occurrences while collapsing a repeated one", () => {
    const first = {
      date: "2026-09-16",
      token: "2026-09-16",
      tool: "ow_session_frame",
      file: "00001-ow_session_frame.json.gz",
      snippet: '"event":"FOMC 9/16"',
    };
    const second = {
      ...first,
      snippet: '"event":"CPI release"',
    };
    const collated = collateDatedEvents([first, second, first], {});
    expect(collated.events).toEqual([second, first]);
    expect(collated.total).toBe(2);
    expect(collated.truncated).toBe(false);
  });

  it("caps the list and says so", () => {
    const many = Array.from({ length: MAX_DATED_EVENTS + 5 }, (_, i) => ({
      date: `2026-09-${String((i % 28) + 1).padStart(2, "0")}`,
      token: `t${String(i)}`,
      tool: "t",
      file: "f.json",
      snippet: `snippet ${String(i)}`,
    }));
    const capped = collateDatedEvents(many, {});
    expect(capped.events).toHaveLength(MAX_DATED_EVENTS);
    expect(capped.total).toBe(MAX_DATED_EVENTS + 5);
    expect(capped.truncated).toBe(true);
  });

  it("is reachable as a built tool and reports its own window", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flash-review-dated-"));
    writeFileSync(
      join(dir, "00001-ow_session_frame.json.gz"),
      gzipSync(Buffer.from(JSON.stringify(FROZEN))),
    );
    const built = buildTools({
      stateRoot: "/state",
      env: { FR_PAGE: "/dev/null", FR_EVIDENCE_DIR: dir },
    }).find((entry) => entry.name === "fr_dated_events");
    const parsed = JSON.parse(
      await built!.run({ from: "2026-09-15", to: "2026-09-20" }),
    ) as { total: number; offset: number; truncated: boolean; events: Array<{ date: string }> };
    expect(parsed.offset).toBe(0);
    expect(parsed.truncated).toBe(false);
    expect(parsed.events.every((event) => event.date === "2026-09-16")).toBe(true);
    expect(parsed.total).toBe(parsed.events.length);
  });

  it("continues a dated-event window from the offset it names", () => {
    const many = Array.from({ length: MAX_DATED_EVENTS + 1 }, (_, i) => ({
      date: "2026-09-16",
      token: `t${String(i)}`,
      tool: "t",
      file: "f.json",
      snippet: `snippet ${String(i)}`,
    }));
    const first = collateDatedEvents(many, {});
    expect(first.nextOffset).toBe(MAX_DATED_EVENTS);
    const last = collateDatedEvents(many, {}, first.nextOffset);
    expect(last.events).toHaveLength(1);
    expect(last.offset).toBe(MAX_DATED_EVENTS);
    expect(last.nextOffset).toBeUndefined();
    expect(last.truncated).toBe(false);
  });
});

describe("fr_evidence traversal", () => {
  function sample(rawBytes: number): string {
    const dir = mkdtempSync(join(tmpdir(), "flash-review-evidence-"));
    writeFileSync(
      join(dir, "00001-ow_probe.json.gz"),
      gzipSync(
        Buffer.from(
          JSON.stringify({ tool: "ow_probe", args: {}, raw: "x".repeat(rawBytes) }),
        ),
      ),
    );
    return dir;
  }
  function tool(dir: string) {
    const found = buildTools({
      stateRoot: "/state",
      env: { FR_PAGE: "/dev/null", FR_EVIDENCE_DIR: dir },
    }).find((entry) => entry.name === "fr_evidence");
    if (found === undefined) throw new Error("fr_evidence was not built");
    return found;
  }

  it("refuses a file name that is not a recording in this directory", async () => {
    await expect(
      tool(sample(100)).run({ file: "../../../etc/passwd" }),
    ).rejects.toThrow(/not a recording name/u);
  });
});

describe("saved reviewer verdict validation", () => {
  function runVerdict(verdict: unknown): () => Buffer {
    const root = mkdtempSync(join(tmpdir(), "flash-review-verdict-"));
    const page = join(root, "page.md");
    const toolIo = join(root, "tool-io");
    writeFileSync(page, "Market conclusion.\n");
    mkdirSync(toolIo);
    writeFileSync(
      join(root, "evidence.json"),
      JSON.stringify({
        run: { toolIo },
        steps: [{ task: "review", role: "reviewer", output: JSON.stringify(verdict) }],
      }),
    );
    // The validator reads saved tool recordings rather than a markdown
    // transcript, so a malformed pass cannot become usable after rendering.
    writeFileSync(
      join(toolIo, "00001-fr_dated_events.json"),
      JSON.stringify({
        tool: "fr_dated_events",
        raw: JSON.stringify({
          window: {},
          total: 1,
          offset: 0,
          returned: 1,
          truncated: false,
          events: [{ date: "2026-09-16", file: "frame.json", snippet: "FOMC" }],
        }),
      }),
    );
    writeFileSync(
      join(toolIo, "00002-fr_evidence.json"),
      JSON.stringify({
        tool: "fr_evidence",
        raw: JSON.stringify({ recordings: [{ file: "frame.json" }] }),
      }),
    );
    return () =>
      execFileSync(
        process.execPath,
        [
          join(PLUGINS, "flash-review", "..", "..", "scripts", "flash-review-validate.mjs"),
          page,
          join(root, "evidence.json"),
        ],
        { stdio: "pipe" },
      );
  }

  it("rejects a malformed pass that carries a major finding", () => {
    expect(() =>
      runVerdict({
        verdict: "pass",
        findings: [
          {
            signature: "date-conflict",
            sentence: "Market conclusion.",
            evidence: "frame.json",
            severity: "major",
          },
        ],
        events_checked: [
          { event: "FOMC", date: "2026-09-16", recording: "frame.json", in_page: false },
        ],
        kept_inference: [],
      })(),
    ).toThrow(/pass conflicts with a blocking or major finding/u);
  });

  it("accepts a structurally complete pass from saved reviewer evidence", () => {
    expect(
      runVerdict({
        verdict: "pass",
        findings: [],
        events_checked: [
          { event: "FOMC", date: "2026-09-16", recording: "frame.json", in_page: true },
        ],
        kept_inference: [],
      })(),
    ).toBeInstanceOf(Buffer);
  });

  it("requires every page in a dated-event sequence", () => {
    const root = mkdtempSync(join(tmpdir(), "flash-review-pages-"));
    const page = join(root, "page.md");
    const toolIo = join(root, "tool-io");
    writeFileSync(page, "Market conclusion.\n");
    mkdirSync(toolIo);
    writeFileSync(
      join(root, "evidence.json"),
      JSON.stringify({
        run: { toolIo },
        steps: [{ task: "review", role: "reviewer", output: JSON.stringify({ verdict: "pass", findings: [], events_checked: Array.from({ length: 81 }, (_, i) => ({ event: `event ${String(i)}`, date: "2026-09-16", recording: "frame.json", in_page: true })), kept_inference: [] }) }],
      }),
    );
    for (const [name, pageResult] of [
      ["00001-fr_dated_events.json", { window: {}, total: 81, offset: 0, returned: 80, nextOffset: 80, truncated: true, events: Array.from({ length: 80 }, (_, i) => ({ date: "2026-09-16", file: "frame.json", tool: "t", token: `t${String(i)}`, snippet: `s${String(i)}` })) }],
      ["00002-fr_dated_events.json", { window: {}, total: 81, offset: 80, returned: 1, truncated: false, events: [{ date: "2026-09-16", file: "frame.json", tool: "t", token: "t80", snippet: "s80" }] }],
    ] as const) writeFileSync(join(toolIo, name), JSON.stringify({ tool: "fr_dated_events", raw: JSON.stringify(pageResult) }));
    const command = () => execFileSync(process.execPath, [join(PLUGINS, "flash-review", "..", "..", "scripts", "flash-review-validate.mjs"), page, join(root, "evidence.json")], { stdio: "pipe" });
    expect(command()).toBeInstanceOf(Buffer);
    // Removing the continuation turns the prior prefix into an inconclusive review.
    writeFileSync(join(toolIo, "00002-fr_dated_events.json"), JSON.stringify({ tool: "fr_evidence", raw: JSON.stringify({ recordings: [{ file: "frame.json" }] }) }));
    expect(command).toThrow(/never completed a dated-event page sequence/u);
  });
});
