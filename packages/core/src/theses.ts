/**
 * ThesisStore — helium-owned standing thesis per job (spec §7). A write is
 * versioned under `<stateDir>/theses/<job>/<utc-ts>.md`, capped at 64 KiB,
 * and re-points a `current` symlink atomically; every write returns a
 * unified diff against whatever `current` pointed to before it.
 * @module @helium/core/theses
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createTwoFilesPatch } from "diff";
import { nowIso } from "./time.js";

const MAX_BYTES = 64 * 1024;

export class ThesisStore {
  constructor(private readonly stateRoot: string) {}

  /** <stateDir>/theses/<job>/ — versions plus a `current` symlink (spec §7). */
  dir(job: string): string {
    return join(this.stateRoot, "theses", job);
  }

  read(job: string): string | null {
    const current = join(this.dir(job), "current");
    if (!existsSync(current)) return null;
    return readFileSync(current, "utf8");
  }

  write(job: string, content: string): { path: string; diff: string } {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_BYTES) {
      throw new Error(
        `thesis rewrite is ${bytes} bytes; the cap is 65536 (64 KiB)`,
      );
    }
    const dir = this.dir(job);
    mkdirSync(dir, { recursive: true });
    const previous = this.read(job) ?? "";
    const stamp = nowIso().replace(/[:.]/g, "-");
    const name = `${stamp}.md`;
    const path = join(dir, name);
    writeFileSync(path, content);

    // Atomic re-point: symlink to a temp name, then rename over `current`.
    const tmp = join(dir, `.current-${stamp}`);
    if (existsSync(tmp)) unlinkSync(tmp);
    symlinkSync(name, tmp); // relative target keeps the tree relocatable
    renameSync(tmp, join(dir, "current"));

    return {
      path,
      diff: createTwoFilesPatch(
        "thesis/previous",
        "thesis/current",
        previous,
        content,
        "previous",
        stamp,
        { context: 3 },
      ),
    };
  }
}
