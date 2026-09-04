/**
 * Every tenant name in this file is made up, and half the cases run one that
 * does not exist anywhere (`livewire-shepherd`, kind `heal`) against a second
 * one with a different kind and a differently shaped document. That symmetry IS
 * the test that the channel stayed generic: the day a branch names a tenant,
 * one of the two halves stops matching the other. Nothing here names the tenant
 * that actually ships this channel, and nothing in the module does either.
 */
import { describe, expect, it, vi } from "vitest";
import type { DeliveryPayload } from "@helium/core";
import channel, {
  ArgonChannel,
  isoWeekOf,
  previousIsoWeek,
  type Poster,
} from "./channel.js";

const ENV = {
  ARGON_BASE_URL: "https://argon.example/",
  ARGON_INGEST_TOKEN: "s3cr3t-token",
} as unknown as NodeJS.ProcessEnv;

function payload(over: Partial<DeliveryPayload> = {}): DeliveryPayload {
  return {
    tenant: "ledger-clerk",
    runId: "run-9be0ec9f",
    subject: "[TEST] a run 2026-09-03",
    body: "the transcript",
    day: "2026-09-03",
    phase: "a-kind",
    codeVersion: "619b89d",
    artifacts: ["/var/reports/a-run.md"],
    rendered: {
      text: "prose",
      html: "<p>prose</p>",
      data: { schemaVersion: 1, date: "2026-09-03", headline: "one sentence" },
    },
    ...over,
  } as DeliveryPayload;
}

/** A stand-in for the other tenant: a different name, a different kind, a
 *  different document shape, and not one line of channel code that knows. */
function otherPayload(over: Partial<DeliveryPayload> = {}): DeliveryPayload {
  return payload({
    tenant: "livewire-shepherd",
    runId: "run-heal-0001",
    subject: "[TEST] heal 2026-09-03",
    phase: "heal",
    rendered: { text: "prose", data: { schemaVersion: 1, gapsRepaired: 3 } },
    ...over,
  });
}

function poster(...statuses: Array<number | "throw">): {
  post: Poster;
  seen: Array<{ url: string; init: Parameters<Poster>[1] }>;
} {
  const seen: Array<{ url: string; init: Parameters<Poster>[1] }> = [];
  let n = 0;
  const post: Poster = async (url, init) => {
    seen.push({ url, init });
    const next = statuses[Math.min(n, statuses.length - 1)];
    n += 1;
    if (next === "throw") throw new Error("ECONNREFUSED");
    return { status: next ?? 201 };
  };
  return { post, seen };
}

function make(post: Poster, env = ENV, sleep = vi.fn(async () => {})) {
  return {
    channel: new ArgonChannel({ env, fetch: post, sleep }),
    sleep,
  };
}

describe("the channel refuses before it reaches the network", () => {
  it("skips with no base URL anywhere", async () => {
    const { post, seen } = poster(201);
    const env = { ARGON_INGEST_TOKEN: "t" } as unknown as NodeJS.ProcessEnv;
    const out = await make(post, env).channel.deliver(payload(), {});
    expect(out.state).toBe("skipped");
    expect(seen).toHaveLength(0);
  });

  it("takes the base URL from the manifest when the environment has none", async () => {
    const { post, seen } = poster(201);
    const env = { ARGON_INGEST_TOKEN: "t" } as unknown as NodeJS.ProcessEnv;
    const out = await make(post, env).channel.deliver(payload(), {
      baseUrl: "https://argon.example",
    });
    expect(out.state).toBe("sent");
    expect(seen[0]?.url).toBe("https://argon.example/api/agent-runs");
  });

  it("skips with no token — an unauthenticated POST is a different request", async () => {
    const { post, seen } = poster(201);
    const env = {
      ARGON_BASE_URL: "https://argon.example",
    } as unknown as NodeJS.ProcessEnv;
    const out = await make(post, env).channel.deliver(payload(), {});
    expect(out.state).toBe("skipped");
    expect(seen).toHaveLength(0);
  });

  it("skips a run with no kind on it", async () => {
    const { post, seen } = poster(201);
    const out = await make(post).channel.deliver(
      payload({ phase: undefined }),
      {},
    );
    expect(out.state).toBe("skipped");
    expect(seen).toHaveLength(0);
  });

  it("skips a kind the manifest did not list", async () => {
    const { post, seen } = poster(201);
    const out = await make(post).channel.deliver(payload(), {
      kinds: ["heal", "digest"],
    });
    expect(out.state).toBe("skipped");
    expect(seen).toHaveLength(0);
  });

  it("skips when the tenant shipped no document", async () => {
    const { post, seen } = poster(201);
    const out = await make(post).channel.deliver(
      payload({ rendered: { text: "prose" } }),
      {},
    );
    expect(out.state).toBe("skipped");
    expect(seen).toHaveLength(0);
  });

  it("FAILS on a rule name it does not implement, without a request", async () => {
    const { post, seen } = poster(201);
    const out = await make(post).channel.deliver(payload(), {
      weekKeyRules: { "a-kind": "last-week-ish" },
    });
    expect(out.state).toBe("failed");
    expect(out.detail).toContain("last-week-ish");
    expect(seen).toHaveLength(0);
  });

  it("FAILS on a document with no integer version", async () => {
    const { post, seen } = poster(201);
    const out = await make(post).channel.deliver(
      payload({ rendered: { text: "prose", data: { date: "2026-09-03" } } }),
      {},
    );
    expect(out.state).toBe("failed");
    expect(out.detail).toContain("schemaVersion");
    expect(seen).toHaveLength(0);
  });
});

describe("the request body is the payload, mapped and not interpreted", () => {
  it("maps every field across by value", async () => {
    const { post, seen } = poster(201);
    await make(post).channel.deliver(payload(), {});
    const init = seen[0]!.init;
    expect(seen[0]!.url).toBe("https://argon.example/api/agent-runs");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers.Authorization).toBe("Bearer s3cr3t-token");
    expect(JSON.parse(init.body)).toEqual({
      tenant: "ledger-clerk",
      kind: "a-kind",
      run_day: "2026-09-03",
      week_key: "2026-W36",
      run_id: "run-9be0ec9f",
      code_sha: "619b89d",
      schema_version: 1,
      outcome: "completed",
      headline: "one sentence",
      view: { schemaVersion: 1, date: "2026-09-03", headline: "one sentence" },
      report: {
        subject: "[TEST] a run 2026-09-03",
        body: "the transcript",
        artifacts: ["/var/reports/a-run.md"],
      },
    });
  });

  it("keeps the transcript BESIDE the document, never merged into it", async () => {
    const { post, seen } = poster(201);
    await make(post).channel.deliver(payload(), {});
    const body = JSON.parse(seen[0]!.init.body) as Record<string, unknown>;
    expect(body.view).not.toHaveProperty("body");
    expect(body.view).not.toHaveProperty("subject");
    expect(body.report).toHaveProperty("body");
  });

  it("treats a tenant it has never heard of exactly the same way", async () => {
    const { post, seen } = poster(201);
    const out = await make(post).channel.deliver(otherPayload(), {
      kinds: ["heal", "digest"],
    });
    expect(out.state).toBe("sent");
    const body = JSON.parse(seen[0]!.init.body) as Record<string, unknown>;
    expect(body.tenant).toBe("livewire-shepherd");
    expect(body.kind).toBe("heal");
    expect(body.week_key).toBe("2026-W36");
    expect(body.view).toEqual({ schemaVersion: 1, gapsRepaired: 3 });
    expect(body.headline).toBe("");
  });

  it("says `unknown` rather than guessing which build ran", async () => {
    const { post, seen } = poster(201);
    await make(post).channel.deliver(
      otherPayload({ codeVersion: undefined }),
      {},
    );
    expect(
      (JSON.parse(seen[0]!.init.body) as Record<string, unknown>).code_sha,
    ).toBe("unknown");
  });
});

describe("which week a run is filed under", () => {
  it("defaults to the ISO week of the day it ran", async () => {
    const { post, seen } = poster(201);
    await make(post).channel.deliver(payload(), {});
    expect(
      (JSON.parse(seen[0]!.init.body) as Record<string, unknown>).week_key,
    ).toBe("2026-W36");
  });

  it("files a backward-looking kind under the week it is ABOUT", async () => {
    const { post, seen } = poster(201);
    await make(post).channel.deliver(
      otherPayload({ day: "2026-09-07", phase: "digest" }),
      { weekKeyRules: { digest: "previous-iso-week" } },
    );
    const body = JSON.parse(seen[0]!.init.body) as Record<string, unknown>;
    expect(body.week_key).toBe("2026-W36");
    expect(body.week_key).not.toBe("2026-W37");
    expect(body.run_day).toBe("2026-09-07");
  });

  it("uses the ISO year, which is not always the calendar year", () => {
    expect(isoWeekOf("2026-09-03")).toBe("2026-W36");
    expect(isoWeekOf("2026-09-07")).toBe("2026-W37");
    // 2026-12-31 is a Thursday, so it belongs to 2026-W53 — the LAST week of
    // the ISO year 2026, not the first of 2027.
    expect(isoWeekOf("2026-12-31")).toBe("2026-W53");
    // The case where the two years really do differ: 2027-01-01 is a Friday in
    // the same ISO week, so it files under 2026 even though it is January.
    expect(isoWeekOf("2027-01-01")).toBe("2026-W53");
    expect(isoWeekOf("2027-01-04")).toBe("2027-W01");
  });

  it("steps back a week by date, never by decrementing the number", () => {
    // Decrementing would give "2027-W00". The year before 2027-W01 ends at W53,
    // and which of W52/W53 it is depends on the year.
    expect(previousIsoWeek("2027-W01")).toBe("2026-W53");
    expect(previousIsoWeek("2026-W37")).toBe("2026-W36");
    expect(previousIsoWeek("2026-W01")).toBe("2025-W52");
  });
});

describe("what the channel does with an answer", () => {
  it("reads 201 as stored", async () => {
    const { post } = poster(201);
    const out = await make(post).channel.deliver(payload(), {});
    expect(out).toEqual({ state: "sent", detail: "created" });
  });

  it("reads 200 as already stored, because ingest is idempotent", async () => {
    const { post } = poster(200);
    const out = await make(post).channel.deliver(payload(), {});
    expect(out.state).toBe("sent");
    expect(out.detail).toContain("idempotent");
  });

  it("does not retry a rejected payload", async () => {
    const { post, seen } = poster(422);
    const { channel: ch, sleep } = make(post);
    const out = await ch.deliver(payload(), {});
    expect(out.state).toBe("failed");
    expect(seen).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a 5xx twice, at 5s then 25s, then gives the run back", async () => {
    const { post, seen } = poster(503);
    const { channel: ch, sleep } = make(post);
    const out = await ch.deliver(payload(), {});
    expect(out.state).toBe("failed");
    expect(seen).toHaveLength(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5000, 25000]);
  });

  it("survives a dropped connection and stores on the second attempt", async () => {
    const { post, seen } = poster("throw", 201);
    const out = await make(post).channel.deliver(payload(), {});
    expect(out.state).toBe("sent");
    expect(seen).toHaveLength(2);
  });

  it("never puts the token in the outcome", async () => {
    const { post } = poster(401);
    const out = await make(post).channel.deliver(payload(), {});
    expect(JSON.stringify(out)).not.toContain("s3cr3t-token");
  });
});

describe("the default export", () => {
  it("is an INSTANCE, so discovery finds a `deliver` on it", () => {
    expect(typeof channel.deliver).toBe("function");
    expect(channel.id).toBe("argon");
    expect(channel.external).toBe(true);
  });
});
