/**
 * Test-only tiny HTTP fixture server. Copied from
 * `plugins/helium/src/testing/http-fixture.ts` (Task 2.1) rather than
 * exported across the package boundary — test-only code duplicates.
 * @module @helium/core/testing/http-fixture
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export interface Fixture {
  url: string;
  close: () => Promise<void>;
}

export async function startFixture(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<Fixture> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

export function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
