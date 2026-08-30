import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentAddressedArtifactStore } from "@helium/core";
import { describe, expect, it, vi } from "vitest";
import { loadShepherdTeamManifest } from "./analysis.js";
import {
  OpenCliReadAdapter,
  buildShepherdTeamTools,
  toolsForShepherdRole,
  type RawSourceResult,
} from "./team-tools.js";

const source = (
  sourceUrl = "https://example.com/source",
  contentKind: RawSourceResult["contentKind"] = "raw-source",
): RawSourceResult => ({
  sourceUrl,
  raw: JSON.stringify({ url: sourceUrl, exact: "raw" }),
  normalized: { rows: [{ value: 1 }] },
  contentKind,
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "helium-shepherd-tools-"));
  const artifacts = new ContentAddressedArtifactStore(join(root, "artifacts"), { sync: () => {} });
  const anySearch = {
    search: vi.fn(async () => source("https://search.example/result", "search-snippet")),
    extract: vi.fn(async ({ url }: { url: string }) => source(url)),
  };
  const livewire = {
    read: vi.fn(async ({ source: name }: { source: "massive" | "ib" }) =>
      name === "ib" ? { state: "AWAITING_USER" as const, reason: "ib-mobile-session" } : source("https://api.massive.com/v2/aggs")),
  };
  const deterministic = {
    eligible: vi.fn(async () => ({
      operations: ["rebuild-partition"],
      evidenceRefs: [{ ref: "artifact://eligibility/one", hash: `sha256:${"a".repeat(64)}` }],
    })),
    probe: vi.fn(async () => source("https://livewire.local/probe")),
  };
  const openCli = { read: vi.fn(async () => source("https://www.sec.gov/filing")) };
  const tools = buildShepherdTeamTools({
    artifacts,
    anySearch,
    livewire,
    deterministic,
    openCli,
    now: () => new Date("2026-08-31T12:00:00.000Z"),
  });
  return { artifacts, anySearch, livewire, deterministic, openCli, tools };
}

const byName = (tools: ReturnType<typeof buildShepherdTeamTools>, name: string) =>
  tools.find((tool) => tool.name === name)!;

describe("Livewire Shepherd team tools", () => {
  it("stores exact source bytes before returning normalized content", async () => {
    const { tools, artifacts } = fixture();
    const output = JSON.parse(await byName(tools, "anysearch.extract").run({
      url: "https://example.com/primary",
    })) as {
      sourceUrl: string;
      retrievalTime: string;
      contentKind: string;
      evidence: { ref: string; hash: string };
    };
    expect(output).toMatchObject({
      sourceUrl: "https://example.com/primary",
      retrievalTime: "2026-08-31T12:00:00.000Z",
      contentKind: "raw-source",
      evidence: { ref: expect.stringMatching(/^artifact:\/\/sha256\//), hash: expect.stringMatching(/^sha256:/) },
    });
    expect(artifacts.read(output.evidence.ref).toString("utf8")).toContain("exact");
    expect(artifacts.verify(output.evidence.ref, output.evidence.hash)).toMatchObject({ size: expect.any(Number) });
  });

  it("marks search as discovery-only and rejects missing source identity", async () => {
    const { tools, anySearch } = fixture();
    const discovery = JSON.parse(await byName(tools, "anysearch.search").run({ query: "index removal", limit: 5 }));
    expect(discovery.contentKind).toBe("search-snippet");
    anySearch.extract.mockResolvedValueOnce(source("not-a-url"));
    await expect(byName(tools, "anysearch.extract").run({ url: "https://example.com" })).rejects.toThrow(/source URL/);
  });

  it("lets an unavailable IB branch wait without blocking Massive evidence", async () => {
    const { tools } = fixture();
    await expect(byName(tools, "livewire.ib.observe").run({ request: { symbol: "AAPL" } })).resolves.toContain("AWAITING_USER");
    const massive = JSON.parse(await byName(tools, "livewire.massive.read").run({ request: { symbol: "AAPL" } }));
    expect(massive.evidence.hash).toMatch(/^sha256:/);
  });

  it("enforces role allowlists and gives planner no execution capability", () => {
    const { tools } = fixture();
    const pit = loadShepherdTeamManifest("pit");
    expect(toolsForShepherdRole(pit, "reporter", tools)).toEqual([]);
    expect(toolsForShepherdRole(pit, "pit-adjudicator", tools).map((tool) => tool.name)).toEqual(["livewire.evidence.read"]);
    expect(toolsForShepherdRole(pit, "repair-planner", tools).map((tool) => tool.name)).toEqual([
      "livewire.evidence.read",
      "livewire.repair.eligible",
    ]);
    expect(toolsForShepherdRole(pit, "corporate-action-universe-researcher", tools).map((tool) => tool.name)).toEqual([
      "livewire.evidence.read", "anysearch.search", "anysearch.extract", "opencli.read",
    ]);
    expect(tools.every((tool) => !tool.mutating)).toBe(true);
  });

  it("bounds normalized and artifact content returned to a model", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-shepherd-tool-bound-"));
    const artifacts = new ContentAddressedArtifactStore(join(root, "artifacts"), { sync: () => {} });
    const raw = "x".repeat(4_000);
    const stored = artifacts.put(raw);
    const tools = buildShepherdTeamTools({
      artifacts,
      anySearch: {
        search: async () => ({ ...source("https://example.com/search", "search-snippet"), normalized: { body: raw } }),
        extract: async () => source(),
      },
      livewire: { read: async () => source() },
      deterministic: {
        eligible: async () => ({ operations: [], evidenceRefs: [] }),
        probe: async () => source(),
      },
      openCli: { read: async () => source() },
      maxAgentBytes: 1_024,
    });
    const search = JSON.parse(await byName(tools, "anysearch.search").run({ query: "x", limit: 1 }));
    expect(search.normalized).toMatchObject({ truncated: true, originalBytes: expect.any(Number) });
    const read = JSON.parse(await byName(tools, "livewire.evidence.read").run({ ref: stored.ref, hash: stored.hash }));
    expect(read).toMatchObject({ truncated: true, originalBytes: 4_000 });
  });
});

describe("OpenCliReadAdapter", () => {
  const catalog = (input: { access?: "read" | "write"; browser?: boolean; args?: unknown[] } = {}) => JSON.stringify([{
    command: "sec/filing",
    access: input.access ?? "read",
    browser: input.browser ?? false,
    args: input.args ?? [
      { name: "url", type: "str", required: true, positional: true },
      { name: "limit", type: "int", required: false, positional: false },
    ],
  }]);

  it("discovers the live catalog, accepts only configured reads, and returns exact JSON", async () => {
    const run = vi.fn(async (argv: string[]) => argv[0] === "list"
      ? { stdout: catalog(), stderr: "" }
      : { stdout: JSON.stringify({ url: "https://www.sec.gov/Archives/one.htm", filing: "8-K" }), stderr: "" });
    const adapter = new OpenCliReadAdapter({ allowedCommands: ["sec/filing"], exec: run });
    const result = await adapter.read({ command: "sec/filing", arguments: { url: "https://www.sec.gov/Archives/one.htm", limit: 1 } });
    expect(result).toMatchObject({ sourceUrl: "https://www.sec.gov/Archives/one.htm", contentKind: "raw-source" });
    expect(run).toHaveBeenLastCalledWith([
      "sec/filing", "https://www.sec.gov/Archives/one.htm", "--limit", "1", "-f", "json",
    ]);
    await expect(adapter.read({ command: "reuters/search", arguments: {} })).rejects.toThrow(/not configured/);
  });

  it("refuses write-like catalog entries and unsafe arguments", async () => {
    const write = new OpenCliReadAdapter({
      allowedCommands: ["sec/filing"],
      exec: async () => ({ stdout: catalog({ access: "write" }), stderr: "" }),
    });
    await expect(write.read({ command: "sec/filing", arguments: {} })).rejects.toThrow(/not read-only/);
    const output = new OpenCliReadAdapter({
      allowedCommands: ["sec/filing"],
      exec: async () => ({ stdout: catalog({ args: [{ name: "output", type: "str", required: false, positional: false }] }), stderr: "" }),
    });
    await expect(output.read({ command: "sec/filing", arguments: {} })).rejects.toThrow(/unsafe argument/);
  });

  it("returns a typed local wait when the Browser Bridge is unstable", async () => {
    const run = vi.fn(async (argv: string[]) => {
      if (argv[0] === "list") return { stdout: catalog({ browser: true }), stderr: "" };
      if (argv[0] === "doctor") return { stdout: "[WARN] Extension: unstable", stderr: "" };
      throw new Error("read command must not run while bridge is unstable");
    });
    const adapter = new OpenCliReadAdapter({ allowedCommands: ["sec/filing"], exec: run });
    await expect(adapter.read({ command: "sec/filing", arguments: { url: "https://www.sec.gov" } })).resolves.toEqual({
      state: "AWAITING_PROVIDER",
      reason: "opencli-browser-bridge-unstable",
    });
    expect(run).toHaveBeenCalledTimes(2);
  });
});
