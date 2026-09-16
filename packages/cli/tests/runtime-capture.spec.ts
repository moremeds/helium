import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { EcosystemTool, LoadedTenant } from "@helium/core";
import { captureRuntimeSources } from "../src/runtime-capture.js";

const tenant = { dir: "/fixture", spec: { tenant: "fixture", calendar: undefined, extensions: {} } } as unknown as LoadedTenant;

function root(): string {
  return mkdtempSync(join(tmpdir(), "runtime-capture-test-"));
}

describe("captureRuntimeSources", () => {
  it("records dynamically reached siblings on the original returned objects", async () => {
    let sibling!: EcosystemTool;
    let receivedEnv: NodeJS.ProcessEnv | undefined;
    const entry: EcosystemTool = {
      name: "entry", description: "", paramsSchema: {} as never, mutating: false,
      run: async () => sibling.run({ nested: { b: 2, a: 1 } }),
    };
    sibling = { name: "source", description: "", paramsSchema: {} as never, mutating: false,
      run: async () => "raw-source" };
    const result = await captureRuntimeSources({ tenant, phase: "premarket", entryTool: "entry", env: { HELIUM_ALLOW_MUTATIONS: "1" } }, {
      makeStateRoot: root, loadTools: async (_dir, cfg) => {
        receivedEnv = cfg.env;
        return [entry, sibling];
      },
    });
    expect(result.status).toBe("COMPLETE");
    expect(result.sourceCount).toBe(2);
    expect(result.sourceFailureCount).toBe(0);
    expect(result.recordingFailureCount).toBe(0);
    expect(receivedEnv?.HELIUM_STATE_ROOT).toBe(result.stateRoot);
    expect(receivedEnv?.HELIUM_TENANT_DELIVERY).toBe("0");
    expect(receivedEnv?.HELIUM_ALLOW_MUTATIONS).toBe("0");
    const files = ["00001-entry.json.gz", "00002-source.json.gz"];
    expect(files.every((file) => existsSync(join(result.stateRoot, "inputs", file)))).toBe(true);
    const record = JSON.parse(gunzipSync(readFileSync(join(result.stateRoot, "inputs", files[1]!))).toString("utf8"));
    expect(record.args).toEqual({ nested: { a: 1, b: 2 } });
    const manifest = JSON.parse(readFileSync(join(result.stateRoot, "capture.json"), "utf8"));
    expect(manifest.replayAsOf).toBe(result.finishedAt);
    expect(manifest.exactSameTimeMarketSnapshot).toBe(false);
    expect(manifest.inputWorldHash).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.eligibility).toBe("DIAGNOSTIC_ONLY");
  });

  it("marks caught source errors and recording failures incomplete", async () => {
    let source!: EcosystemTool;
    const entry: EcosystemTool = { name: "entry", description: "", paramsSchema: {} as never, mutating: false,
      run: async () => { try { await source.run({}); } catch {} return "entry-result"; } };
    source = { name: "source", description: "", paramsSchema: {} as never, mutating: false,
      run: async () => { throw new Error("source failed"); } };
    const result = await captureRuntimeSources({ tenant, phase: "premarket", entryTool: "entry", env: {} }, {
      makeStateRoot: root, loadTools: async () => [entry, source],
      write: () => { throw new Error("disk failed"); },
    });
    expect(result.status).toBe("INCOMPLETE");
    expect(result.entry.raw).toBe("entry-result");
    expect(result.failures.map((failure) => failure.kind)).toContain("tool");
    expect(result.failures.map((failure) => failure.kind)).toContain("recording");
    expect(JSON.parse(readFileSync(join(result.stateRoot, "capture.json"), "utf8")).status).toBe("INCOMPLETE");
  });

  it("refuses mutating siblings and mutating entries", async () => {
    let mutation!: EcosystemTool;
    let invoked = false;
    const entry: EcosystemTool = { name: "entry", description: "", paramsSchema: {} as never, mutating: false,
      run: async () => mutation.run({}) };
    mutation = { name: "mutation", description: "", paramsSchema: {} as never, mutating: true,
      run: async () => { invoked = true; return "should not run"; } };
    const result = await captureRuntimeSources({ tenant, phase: "premarket", entryTool: "entry", env: {} }, {
      makeStateRoot: root, loadTools: async () => [entry, mutation],
    });
    expect(result.status).toBe("INCOMPLETE");
    expect(result.failures[0]?.error).toContain("Capture refuses mutating tool");
    expect(invoked).toBe(false);
    await expect(captureRuntimeSources({ tenant, phase: "premarket", entryTool: "mutation", env: {} }, {
      makeStateRoot: root, loadTools: async () => [mutation],
    })).rejects.toThrow("Capture entry tool is mutating");
  });
});
