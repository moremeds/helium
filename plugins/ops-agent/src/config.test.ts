import { describe, expect, it } from "vitest";
import { OpsConfigSchema } from "./config.js";

const base = {
  componentsDir: "ops/components",
  sopsDir: "ops/sops",
  checksDir: "ops/checks",
  authorityManifestPath: "ops/authority-manifest.json",
  trustedKeyPath: "ops/authority-manifest.pub.pem",
};

describe("OpsConfigSchema", () => {
  it("applies bounded defaults", () => {
    const config = OpsConfigSchema.parse(base);
    expect(config.maxFiles).toBe(500);
    expect(config.maxComponents).toBe(200);
    expect(config.maxFileBytes).toBe(1_000_000);
  });

  // The loader reads files an operator edits by hand. An unbounded loader
  // turns a typo into an unbounded startup, on the process that is supposed to
  // still be working when everything else is not.
  it("refuses an unbounded limit", () => {
    for (const key of ["maxFiles", "maxComponents", "maxSops", "maxChecks"]) {
      expect(() => OpsConfigSchema.parse({ ...base, [key]: 0 })).toThrow();
      expect(() => OpsConfigSchema.parse({ ...base, [key]: 10_000_000 })).toThrow();
    }
  });

  it("refuses an unknown key rather than ignoring it", () => {
    expect(() => OpsConfigSchema.parse({ ...base, allowShell: true })).toThrow();
  });

  it("requires every path", () => {
    for (const key of Object.keys(base)) {
      const { [key]: _drop, ...without } = base as Record<string, unknown>;
      expect(() => OpsConfigSchema.parse(without)).toThrow();
    }
  });
});
