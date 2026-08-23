import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readEnvFile } from "./envfile.js";

describe("readEnvFile", () => {
  it("reads KEY=VAL, skips comments and blanks, strips quotes, keeps = in values", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-env-"));
    const file = join(dir, "helium.env");
    writeFileSync(
      file,
      [
        "# comment",
        "",
        "SMTP_HOST=smtp.example.com",
        "SMTP_PORT=587",
        'SMTP_PASS="p=ss word"',
        "SMTP_USER='ops'",
        "export DEEPSEEK_API_KEY=sk-abc",
        "JUNK",
      ].join("\n"),
    );
    expect(readEnvFile(file)).toEqual({
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "587",
      SMTP_PASS: "p=ss word",
      SMTP_USER: "ops",
      DEEPSEEK_API_KEY: "sk-abc",
    });
  });

  it("returns an empty map when the file does not exist", () => {
    expect(readEnvFile("/nonexistent/helium.env")).toEqual({});
  });
});
