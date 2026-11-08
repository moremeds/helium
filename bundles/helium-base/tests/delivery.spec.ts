import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deliver, isoWeekOf, type DeliveryContext, type Poster } from "../src/delivery.js";
import { openStore } from "../src/store.js";

function ctx(env: NodeJS.ProcessEnv, fetch?: Poster): DeliveryContext & { sent: { url: string; body: any }[] } {
  const root = mkdtempSync(join(tmpdir(), "helium-delivery-"));
  const db = openStore(root);
  db.prepare("INSERT INTO runs (id, bundle, phase, as_of, code, started_at, status) VALUES ('r1', 'b', 'close', '2026-11-06', 'abc', 'now', 'running')").run();
  const sent: { url: string; body: any }[] = [];
  const post: Poster = fetch ?? (async (url, init) => (sent.push({ url, body: JSON.parse(init.body) }), { status: 201, text: async () => "" }));
  return { db, stateRoot: root, runId: "r1", bundle: "b", phase: "close", day: "2026-11-06", code: "abc", env, fetch: post, sleep: async () => {}, sent };
}

const doc = { subject: "S", text: "body", data: { schemaVersion: 1, headline: "H" } };
const live = { HELIUM_TENANT_DELIVERY: "1", HELIUM_EMAIL_TO: "a@example.com", RESEND_HELIUM_TOKEN: "k", HELIUM_EMAIL_MAX_PER_DAY: "1", ARGON_BASE_URL: "http://argon/", ARGON_INGEST_TOKEN: "t" };

describe("delivery", () => {
  it("throws on a channel the bundle did not declare", async () => {
    await expect(deliver("argon", doc, ["email", "markdown"], ctx(live))).rejects.toThrow(/does not declare channel argon/);
  });

  it("holds external channels behind the operator brake, not markdown", async () => {
    const c = ctx({ ...live, HELIUM_TENANT_DELIVERY: undefined });
    expect((await deliver("email", doc, ["email", "markdown"], c)).state).toBe("skipped");
    expect((await deliver("markdown", doc, ["email", "markdown"], c)).state).toBe("sent");
    expect(c.sent).toHaveLength(0);
  });

  it("marks email as a drill unless production, and caps per day", async () => {
    const c = ctx(live);
    expect((await deliver("email", doc, ["email"], c)).state).toBe("sent");
    expect(c.sent[0]!.body.subject).toBe("[TEST] S");
    expect((await deliver("email", doc, ["email"], c)).state).toBe("rate-capped");
    const p = ctx({ ...live, HELIUM_DEPLOYMENT: "production" });
    await deliver("email", doc, ["email"], p);
    expect(p.sent[0]!.body.subject).toBe("S");
  });

  it("records intent before the send and the outcome after", async () => {
    let during: unknown;
    const c = ctx(live, async () => {
      during = c.db.prepare("SELECT state FROM deliveries").get();
      return { status: 201, text: async () => "" };
    });
    await deliver("argon", doc, ["argon"], c);
    expect(during).toEqual({ state: "intent" });
    expect(c.db.prepare("SELECT state FROM deliveries").get()).toEqual({ state: "sent" });
  });

  it("posts argon once on any 4xx, 429 included, and three times on 5xx", async () => {
    let n = 0;
    const c4 = ctx(live, async () => (n++, { status: 422, text: async () => "bad" }));
    expect((await deliver("argon", doc, ["argon"], c4)).state).toBe("failed");
    expect(n).toBe(1);
    n = 0;
    const c5 = ctx(live, async () => (n++, { status: 503, text: async () => "" }));
    expect((await deliver("argon", doc, ["argon"], c5)).state).toBe("failed");
    expect(n).toBe(3);
    n = 0;
    const c429 = ctx(live, async () => (n++, { status: 429, text: async () => "" }));
    expect((await deliver("argon", doc, ["argon"], c429)).state).toBe("failed");
    expect(n).toBe(1);
  });

  it("sends nothing more once the run is aborted", async () => {
    let n = 0;
    const stop = new AbortController();
    const c = ctx(live, async () => (n++, stop.abort(), { status: 503, text: async () => "" }));
    c.signal = stop.signal;
    const out = await deliver("argon", doc, ["argon"], c);
    expect(out.state).toBe("failed");
    expect(out.detail).toMatch(/aborted before attempt 2/);
    expect(n).toBe(1);
  });

  it("files argon runs under the ISO week, ISO year at the boundary", async () => {
    const c = ctx(live);
    await deliver("argon", doc, ["argon"], c);
    expect(c.sent[0]!.body).toMatchObject({ tenant: "b", kind: "close", run_id: "r1", week_key: "2026-W45", schema_version: 1 });
    expect(isoWeekOf("2027-01-01")).toBe("2026-W53");
  });
});
