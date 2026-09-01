#!/usr/bin/env node
/** Operator CLI for P4 controlled requests and human review decisions. */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { TeamReviewStore } from "../../plugins/helium/lib/promotion.js";

const command = process.argv[2];
const args = process.argv.slice(3);
const allowed = new Set([
  "--state-root",
  "--tenant",
  "--case-key",
  "--operator",
  "--reason",
  "--review-id",
  "--decision",
]);
const flags = new Map();
for (let i = 0; i < args.length; i += 2) {
  const flag = args[i];
  const value = args[i + 1];
  if (!allowed.has(flag) || value === undefined || flags.has(flag)) {
    throw new Error(`invalid argument: ${flag ?? "<missing>"}`);
  }
  flags.set(flag, value);
}

const stateRoot = flags.get("--state-root")
  ?? process.env.HELIUM_STATE_ROOT
  ?? join(homedir(), ".helium", "state");

function required(name) {
  const value = flags.get(name);
  if (value === undefined || value.trim() === "") throw new Error(`missing ${name}`);
  return value;
}

function syncDirectory(path) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeRequest() {
  const tenant = required("--tenant");
  const caseKey = required("--case-key");
  const requestedBy = required("--operator");
  const reason = required("--reason");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(caseKey)) {
    throw new Error("invalid --case-key");
  }
  const now = new Date();
  const request = {
    version: 1,
    requestId: `canary-${randomBytes(12).toString("hex")}`,
    caseKey,
    tenant,
    requestedBy,
    reason,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
  };
  const directory = join(stateRoot, "team-canary", "requests");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${request.requestId}.json`);
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(request)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(directory);
  return { ...request, path };
}

function outcomes() {
  const root = join(stateRoot, "team-canary");
  return ["processed", "failed", "rejected"].flatMap((state) => {
    const directory = join(root, state);
    let names;
    try { names = readdirSync(directory); } catch { return []; }
    return names
      .filter((name) => name.endsWith(".outcome.json"))
      .sort()
      .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")));
  });
}

function withArtifactContents(item) {
  return {
    ...item,
    artifactContents: item.team.artifacts.map((artifact) => {
      const path = join(
        stateRoot,
        "teams",
        "cases",
        encodeURIComponent(item.team.caseId),
        "artifacts",
        artifact.hash.replace(/^sha256:/, ""),
      );
      const bytes = readFileSync(path);
      const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (actual !== artifact.hash) throw new Error(`artifact hash mismatch: ${artifact.ref}`);
      const text = bytes.toString("utf8");
      let content;
      try { content = JSON.parse(text); } catch { content = text; }
      return { ...artifact, content };
    }),
  };
}

const reviews = new TeamReviewStore(stateRoot);
let output;
switch (command) {
  case "request":
    output = writeRequest();
    break;
  case "list":
    output = reviews.pending();
    break;
  case "show":
    output = withArtifactContents(reviews.get(required("--review-id")));
    break;
  case "decide": {
    const decision = required("--decision");
    if (decision !== "accepted" && decision !== "rejected") {
      throw new Error("--decision must be accepted or rejected");
    }
    output = reviews.decide({
      reviewId: required("--review-id"),
      decision,
      operator: required("--operator"),
      reason: required("--reason"),
    });
    break;
  }
  case "outcomes":
    output = outcomes();
    break;
  default:
    throw new Error("usage: team-canary.mjs request|list|show|decide|outcomes [flags]");
}
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
