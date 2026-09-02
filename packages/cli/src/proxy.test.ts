import { describe, expect, it } from "vitest";
import { applyProxy } from "./proxy.js";

describe("applyProxy", () => {
  it("does nothing when no proxy is configured", () => {
    expect(applyProxy({})).toBeUndefined();
    expect(applyProxy({ HELIUM_PROXY: "  " })).toBeUndefined();
  });

  it("prefers the helium-specific variable over the ambient one", () => {
    expect(
      applyProxy({ HELIUM_PROXY: "http://127.0.0.1:7897", HTTPS_PROXY: "http://other:1" }),
    ).toBe("http://127.0.0.1:7897");
  });

  it("falls back to HTTPS_PROXY, which is what node itself ignores", () => {
    expect(applyProxy({ HTTPS_PROXY: "http://127.0.0.1:7897" })).toBe("http://127.0.0.1:7897");
  });
});
