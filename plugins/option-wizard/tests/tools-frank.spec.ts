/**
 * ow_frank shells out to opencli twice and reads the file the second call
 * wrote. Both calls are mocked — CI has no opencli and no Substack session —
 * but the file the tool reads is a real file in a real scratch cwd, because
 * "which .md did web read just write" is the part that can actually break.
 *
 * The listing fixture is the real observed post (2026-08-31), not an invention.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { bin: string; argv: string[]; cwd: string | undefined };

const state = vi.hoisted(() => ({
  calls: [] as Call[],
  /** Per-test behaviour: given a call, either write files and/or return stdout. */
  handler: (() => "") as (call: { bin: string; argv: string[]; cwd?: string }) => string,
}));

// `execFile` is wrapped in `promisify` at module load, so the mock is driven
// callback-style. Real execFile resolves to `{ stdout, stderr }` through its
// util.promisify.custom hook; the callback here hands back that same object so
// the code under test sees exactly what it sees in production.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFile = vi.fn(
    (bin: string, argv: string[], opts: { cwd?: string }, cb: (e: unknown, r: unknown) => void) => {
      state.calls.push({ bin, argv, cwd: opts?.cwd });
      try {
        cb(null, { stdout: state.handler({ bin, argv, cwd: opts?.cwd }), stderr: "" });
      } catch (error: unknown) {
        cb(error, { stdout: "", stderr: "" });
      }
    },
  );
  return { ...actual, execFile };
});

const { buildTools } = await import("../tools/index.js");

/** The real observed post, 2026-08-31. Frank's slugs are date-prefixed
 *  (MMDDYYYY), which is what tells an article from an evergreen index page. */
const LISTING = JSON.stringify([
  {
    title: "08/31/2026 复盘与展望",
    url: "https://franktrading.substack.com/p/08312026-trading-recap-and-outlook",
    publish_time: "2026-08-31T12:37:14.509Z",
  },
]);
/** Long enough to clear the tool's body floor; a real note runs tens of KB. */
const ARTICLE =
  "# 08/31/2026 复盘与展望\n\nSPY 收在 764 附近。\n" + "市场结构没有改变。".repeat(80);

let stateRoot: string;

function frankTool(env: Record<string, string | undefined> = {}) {
  const found = buildTools({ stateRoot, env }).find((t) => t.name === "ow_frank");
  if (found === undefined) throw new Error("no tool ow_frank");
  return found;
}

/** The default: list one post, then have `web read` write the article file. */
function writesTheArticle(call: { argv: string[]; cwd?: string }): string {
  if (call.argv[0] === "substack") return LISTING;
  const slug = "08-31-2026-复盘与展望";
  const dir = join(call.cwd!, "web-articles", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.md`), ARTICLE);
  return JSON.stringify({ status: "success" });
}

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "ow-frank-"));
  state.calls = [];
  state.handler = writesTheArticle;
});

describe("ow_frank", () => {
  it("asks opencli for one post and reads it in the scratch cwd", async () => {
    const out = JSON.parse(await frankTool().run({})) as {
      url: string;
      publishedAt: string;
      title: string;
      markdown: string;
    };
    expect(state.calls[0]).toEqual({
      bin: "opencli",
      argv: [
        "substack",
        "publication",
        "https://franktrading.substack.com",
        "--limit",
        "10",
        "-f",
        "json",
      ],
      cwd: join(stateRoot, "scratch", "frank"),
    });
    expect(state.calls[1].argv).toEqual([
      "web",
      "read",
      "--url",
      "https://franktrading.substack.com/p/08312026-trading-recap-and-outlook",
    ]);
    expect(out.url).toBe(
      "https://franktrading.substack.com/p/08312026-trading-recap-and-outlook",
    );
    expect(out.publishedAt).toBe("2026-08-31T12:37:14.509Z");
    expect(out.title).toBe("08/31/2026 复盘与展望");
    expect(out.markdown).toContain("复盘与展望");
    // The scratch dir is under the state root, never the checkout. Each read
    // gets its own directory named for the url, so the .md the tool picks up
    // can only be the one this call wrote.
    expect(existsSync(join(stateRoot, "scratch", "frank", "reads"))).toBe(true);
  });

  it("honours OW_OPENCLI_BIN", async () => {
    await frankTool({ OW_OPENCLI_BIN: "/usr/local/bin/opencli" }).run({});
    expect(state.calls.map((call) => call.bin)).toEqual([
      "/usr/local/bin/opencli",
      "/usr/local/bin/opencli",
    ]);
  });

  it("falls back to the default binary when the key is blank", async () => {
    await frankTool({ OW_OPENCLI_BIN: "  " }).run({});
    expect(state.calls[0].bin).toBe("opencli");
  });

  it("throws when web read wrote no markdown", async () => {
    state.handler = (call) =>
      call.argv[0] === "substack" ? LISTING : JSON.stringify({ status: "success" });
    await expect(frankTool().run({})).rejects.toThrow(/wrote no markdown for/u);
  });

  it("throws when the listing carries no post url", async () => {
    state.handler = (call) => (call.argv[0] === "substack" ? "[]" : "");
    await expect(frankTool().run({})).rejects.toThrow(/no post url in/u);
  });

  it("follows the first dated link when the listing hands back an index page", async () => {
    // `/p/weekly-recap-and-outlook` is the evergreen index: a page of "Read
    // full story" teasers and no body. Returning it as Frank's note makes the
    // whole comparison run against nothing.
    const INDEX =
      "# Weekly Recap\n\n[Read full story](https://franktrading.substack.com/p/08312026-trading-recap-and-outlook)\n" +
      "[Read full story](https://franktrading.substack.com/p/08242026-trading-recap-and-outlook)\n" +
      "[Read full story](https://franktrading.substack.com/p/08172026-trading-recap-and-outlook)\n";
    state.handler = (call) => {
      if (call.argv[0] === "substack")
        return JSON.stringify([
          {
            title: "Weekly Recap and Outlook",
            url: "https://franktrading.substack.com/p/weekly-recap-and-outlook",
            publish_time: "2026-08-31T12:37:14.509Z",
          },
        ]);
      const url = call.argv[3];
      const slug = url.split("/p/")[1];
      const dir = join(call.cwd!, "web-articles", slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${slug}.md`), slug.startsWith("weekly") ? INDEX : ARTICLE);
      return JSON.stringify({ status: "success" });
    };
    const out = JSON.parse(await frankTool().run({})) as { url: string; markdown: string };
    expect(out.url).toBe(
      "https://franktrading.substack.com/p/08312026-trading-recap-and-outlook",
    );
    expect(out.markdown).toContain("复盘与展望");
  });

  it("skips undated index rows in the listing and reads the first dated post directly", async () => {
    // Recorded 2026-09-04: the listing puts the evergreen index and the
    // Education page above every dated post. The tool must never read the
    // index when a dated row is right there.
    const reads: string[] = [];
    state.handler = (call) => {
      if (call.argv[0] === "substack")
        return JSON.stringify([
          { title: "Weekly Recap and Outlook", url: "https://franktrading.substack.com/p/weekly-recap-and-outlook" },
          { title: "Education", url: "https://franktrading.substack.com/p/education" },
          { title: "08/31/2026 Trading Recap and Outlook", url: "https://franktrading.substack.com/p/08312026-trading-recap-and-outlook" },
          { title: "08/24/2026 Trading Recap and Outlook", url: "https://franktrading.substack.com/p/08242026-trading-recap-and-outlook" },
        ]);
      const url = call.argv[3];
      reads.push(url);
      const slug = url.split("/p/")[1];
      const dir = join(call.cwd!, "web-articles", slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${slug}.md`), ARTICLE);
      return JSON.stringify({ status: "success" });
    };
    const out = JSON.parse(await frankTool().run({})) as { url: string };
    expect(out.url).toBe("https://franktrading.substack.com/p/08312026-trading-recap-and-outlook");
    expect(reads).toEqual(["https://franktrading.substack.com/p/08312026-trading-recap-and-outlook"]);
  });

  it("refuses an index page with no dated article link on it", async () => {
    state.handler = (call) => {
      if (call.argv[0] === "substack")
        return JSON.stringify([
          { url: "https://franktrading.substack.com/p/weekly-recap-and-outlook" },
        ]);
      const dir = join(call.cwd!, "web-articles", "weekly");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "weekly.md"), "# Weekly\n\nnothing dated here.\n");
      return JSON.stringify({ status: "success" });
    };
    await expect(frankTool().run({})).rejects.toThrow(
      /not a dated article slug and its page carries no dated article link/u,
    );
  });

  it("refuses a body too short to be a note", async () => {
    state.handler = (call) => {
      if (call.argv[0] === "substack") return LISTING;
      const dir = join(call.cwd!, "web-articles", "cut");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "cut.md"), "# 08/31/2026\n\npaywalled.\n");
      return JSON.stringify({ status: "success" });
    };
    await expect(frankTool().run({})).rejects.toThrow(/not the note/u);
  });

  it("names the failing command when opencli itself fails", async () => {
    state.handler = () => {
      throw new Error("spawn opencli ENOENT");
    };
    await expect(frankTool().run({})).rejects.toThrow(
      /ow_frank: opencli substack publication .* failed — .*ENOENT/su,
    );
  });
});
