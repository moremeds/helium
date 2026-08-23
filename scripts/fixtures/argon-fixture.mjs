#!/usr/bin/env node
// Mutable argon stand-in for the local E2E harness (Task 3.1) and the AC#3
// mini drill (Task 3.7). GET returns whatever JSON `FIXTURE_STATE` currently
// holds; POST /__set replaces it. Prints the bound port as JSON on stdout so
// the spawning test can read it off an ephemeral port.
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.FIXTURE_STATE ?? "./fixture-state.json";
const port = Number(process.env.FIXTURE_PORT ?? 0);

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/__set") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      writeFileSync(statePath, body, "utf8");
      res.writeHead(204).end();
    });
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(readFileSync(statePath, "utf8"));
});

server.listen(port, "127.0.0.1", () => {
  const addr = server.address();
  console.log(
    JSON.stringify({
      port: typeof addr === "object" && addr ? addr.port : port,
    }),
  );
});
