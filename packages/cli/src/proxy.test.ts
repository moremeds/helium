import { describe, expect, it } from "vitest";
import { applyProxy } from "./proxy.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";

describe("applyProxy", () => {
  it("reaches an excluded local data service even when the proxy is unavailable", async () => {
    const previous = getGlobalDispatcher();
    const server = createServer((_req, res) => res.end("local data"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    applyProxy({ HELIUM_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1" });
    const applied = getGlobalDispatcher();
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      expect(await response.text()).toBe("local data");
    } finally {
      setGlobalDispatcher(previous);
      await applied.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
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
