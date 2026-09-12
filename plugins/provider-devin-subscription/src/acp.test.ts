import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { DevinAcpClient, type AcpChild } from "./acp.js";

/** A scriptable fake child: emit bytes/events in whatever order a test needs. */
function stubChild(): AcpChild & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  bus: EventEmitter;
  written: string[];
  killed: string[];
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const bus = new EventEmitter();
  const written: string[] = [];
  const killed: string[] = [];
  return {
    stdout, stderr, bus, written, killed,
    stdin: { write: (chunk: string) => { written.push(chunk); return true; } },
    on(event: string, cb: (...args: unknown[]) => void) { bus.on(event, cb); return bus; },
    kill(signal?: string) { killed.push(signal ?? "SIGTERM"); return true; },
  } as unknown as AcpChild & { stdout: EventEmitter; stderr: EventEmitter; bus: EventEmitter; written: string[]; killed: string[] };
}

const opts = (child: AcpChild, sinks: {
  stdout?: Buffer[]; stderr?: Buffer[]; frames?: string[]; tail?: string[];
}) => ({
  argv: ["devin", "acp", "--agent-type", "summarizer", "--model", "swe-2-max"],
  cwd: "/tmp",
  env: { PATH: "/usr/bin" },
  spawn: () => child,
  onStdoutBytes: (chunk: Buffer) => sinks.stdout?.push(chunk),
  onStderrBytes: (chunk: Buffer) => sinks.stderr?.push(chunk),
  onFrame: (dir: string, line: string) => sinks.frames?.push(`${dir}:${line}`),
  onStdoutTail: (text: string) => sinks.tail?.push(text),
});

const frame = (payload: Record<string, unknown>) => Buffer.from(JSON.stringify(payload) + "\n", "utf8");
const ok = (id: string, result: unknown) => frame({ jsonrpc: "2.0", id, result });

/** Wait until the client actually wrote a request for `method` — never answer early. */
async function waitForWrite(child: ReturnType<typeof stubChild>, method: string): Promise<string> {
  for (let i = 0; i < 200; i += 1) {
    const line = child.written.find((l) => l.includes(`"method":"${method}"`));
    if (line !== undefined) return (JSON.parse(line) as { id: string }).id;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`client never wrote ${method}`);
}

describe("DevinAcpClient byte fidelity and lifecycle", () => {
  it("preserves raw bytes for a multibyte character split across chunks", async () => {
    const child = stubChild();
    const stdout: Buffer[] = [];
    const frames: string[] = [];
    const client = new DevinAcpClient(opts(child, { stdout, frames }));
    const openPromise = client.open(5_000);
    // 4-byte emoji U+1F600 split across the chunk boundary inside a
    // notification's string value.
    const emoji = Buffer.from("😀", "utf8");
    const pre = Buffer.from('{"jsonrpc":"2.0","method":"_cognition.ai/output","params":{"message":"emoji:', "utf8");
    const post = Buffer.from('"}}\n', "utf8");
    child.stdout.emit("data", Buffer.concat([pre, emoji.subarray(0, 2)]));
    child.stdout.emit("data", Buffer.concat([emoji.subarray(2), post]));
    child.stdout.emit("data", ok(await waitForWrite(child, "initialize"), { protocolVersion: 1, authMethods: [], agentInfo: { name: "stub" } }));
    child.stdout.emit("data", ok(await waitForWrite(child, "session/new"), { sessionId: "s1" }));
    expect(await openPromise).toBe("s1");
    const raw = Buffer.concat(stdout);
    // The raw byte stream must equal what the child wrote — no U+FFFD.
    expect(raw.includes(emoji)).toBe(true);
    expect(raw.toString("utf8")).toContain("emoji:😀");
    // The parser also survived the split — the complete frame decoded intact.
    expect(frames.some((f) => f.includes("emoji:😀"))).toBe(true);
    child.bus.emit("exit", 0, null);
    child.bus.emit("close", 0, null);
    await client.close();
  });

  it("captures stdout data emitted after 'exit' but before 'close'", async () => {
    const child = stubChild();
    const stdout: Buffer[] = [];
    const tail: string[] = [];
    const client = new DevinAcpClient(opts(child, { stdout, tail }));
    const openPromise = client.open(5_000);
    const initId = await waitForWrite(child, "initialize");
    // Real pipes deliver trailing data between exit and close.
    child.bus.emit("exit", 0, null);
    child.stdout.emit("data", ok(initId, { protocolVersion: 1, authMethods: [], agentInfo: { name: "stub" } }));
    const newId = await waitForWrite(child, "session/new");
    child.stdout.emit("data", ok(newId, { sessionId: "s1" }));
    child.stdout.emit("data", Buffer.from("incomplete-tail-without-newline", "utf8"));
    child.bus.emit("close", 0, null);
    expect(await openPromise).toBe("s1");
    expect(stdout.map((b) => b.toString("utf8")).join("")).toContain("incomplete-tail-without-newline");
    expect(tail).toEqual(["incomplete-tail-without-newline"]);
  });

  it("rejects open promptly on spawn error instead of hanging", async () => {
    const child = stubChild();
    const client = new DevinAcpClient(opts(child, {}));
    const openPromise = client.open(60_000);
    child.bus.emit("error", Object.assign(new Error("spawn devin ENOENT"), { code: "ENOENT" }));
    await expect(openPromise).rejects.toThrow("initialize");
  });

  it("times out a hung initialize under the open deadline and stays killable", async () => {
    const child = stubChild();
    const client = new DevinAcpClient(opts(child, {}));
    const openPromise = client.open(50);
    await expect(openPromise).rejects.toThrow("timed out");
    await client.close();
    expect(child.killed).toContain("SIGTERM");
  });

  it("close() returns even when the child never emits close", async () => {
    const child = stubChild();
    const client = new DevinAcpClient(opts(child, {}));
    const openPromise = client.open(5_000);
    child.stdout.emit("data", ok(await waitForWrite(child, "initialize"), { protocolVersion: 1, authMethods: [], agentInfo: { name: "stub" } }));
    child.stdout.emit("data", ok(await waitForWrite(child, "session/new"), { sessionId: "s1" }));
    await openPromise;
    // No exit/close events at all — the stub is wedged.
    await client.close(30);
    expect(child.killed).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("refuses agent-originated fs/terminal requests and cancels permission prompts", async () => {
    const child = stubChild();
    const frames: string[] = [];
    const client = new DevinAcpClient(opts(child, { frames }));
    const openPromise = client.open(5_000);
    child.stdout.emit("data", ok(await waitForWrite(child, "initialize"), { protocolVersion: 1, authMethods: [], agentInfo: { name: "stub" } }));
    child.stdout.emit("data", ok(await waitForWrite(child, "session/new"), { sessionId: "s1" }));
    await openPromise;
    child.stdout.emit("data", frame({ jsonrpc: "2.0", id: "srv-1", method: "fs/read_text_file", params: { path: "/etc/passwd" } }));
    child.stdout.emit("data", frame({ jsonrpc: "2.0", id: "srv-2", method: "session/request_permission", params: {} }));
    await new Promise((r) => setTimeout(r, 10));
    const out = frames.filter((f) => f.startsWith("out:")).map((f) => f.slice(4));
    expect(out.find((f) => f.includes('"srv-1"'))).toContain("-32601");
    expect(out.find((f) => f.includes('"srv-2"'))).toContain("cancelled");
    child.bus.emit("exit", 0, null);
    child.bus.emit("close", 0, null);
    await client.close();
  });
});
