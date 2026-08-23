#!/usr/bin/env node
// Minimal alert mailer. Reads SMTP config from a 0600 env file; never prints
// a secret value. Exit: 0 sent, 2 config error, 3 send failed.
import { readFileSync } from "node:fs";
import nodemailer from "nodemailer";

// --dry-run takes no value, so it is special-cased before the flag/value
// pairing below — otherwise it would shift every later pair by one slot.
const args = new Map();
const rest = process.argv.slice(2);
let dryRun = false;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--dry-run") {
    dryRun = true;
    continue;
  }
  args.set(rest[i], rest[i + 1]);
  i += 1;
}
const envFile =
  args.get("--env-file") ?? "/Users/moremeds/.config/helium/helium.env";
const subject = args.get("--subject") ?? "helium alert";
const body = args.get("--body-file")
  ? readFileSync(args.get("--body-file"), "utf8")
  : (args.get("--body") ?? "");

const cfg = {};
for (const line of readFileSync(envFile, "utf8").split("\n")) {
  const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (!m) continue;
  cfg[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2").trim();
}
const need = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
  "HELIUM_EMAIL_TO",
];
const missing = need.filter((k) => !cfg[k]);
if (missing.length > 0) {
  console.log(
    JSON.stringify({ ok: false, error: "missing config keys", missing }),
  );
  process.exit(2);
}
try {
  const transportOpts = {
    host: cfg.SMTP_HOST,
    port: Number(cfg.SMTP_PORT),
    secure: cfg.SMTP_SECURE === "true" || Number(cfg.SMTP_PORT) === 465,
    auth: { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS },
    // --dry-run / jsonTransport: nothing touches the network, so local tests
    // and drills never send a real email.
    ...(dryRun ? { jsonTransport: true } : {}),
  };
  const info = await nodemailer.createTransport(transportOpts).sendMail({
    from: cfg.SMTP_FROM,
    to: cfg.HELIUM_EMAIL_TO,
    subject,
    text: body,
  });
  console.log(
    JSON.stringify({
      ok: true,
      dryRun,
      messageId: info.messageId,
      accepted: dryRun ? undefined : info.accepted.length,
    }),
  );
} catch (e) {
  console.log(
    JSON.stringify({
      ok: false,
      error: String(e && e.message ? e.message : e),
    }),
  );
  process.exit(3);
}
