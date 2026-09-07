import { gzipSync } from "node:zlib";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadTenants } from "@helium/core";
import { MAX_RAW_BYTES, VOCABULARY, buildTools } from "../tools/index.js";

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
