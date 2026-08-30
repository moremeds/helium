/**
 * The certified script registry.
 *
 * A registered script is a PATH plus a pinned identity plus an argv schema.
 * There is no field anywhere in which a command string could be represented,
 * and nothing here ever concatenates a string into a command line. Arguments
 * are validated element by element against declared patterns before a spawn is
 * even attempted.
 * @module dsh-plugin-ops-agent/script-registry
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";

const IdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

/**
 * One permitted argument. `flag` is matched literally; `valuePattern` is
 * anchored and applied to the value that follows it. A value that does not
 * match is a refusal, not a sanitization -- there is no escaping step here
 * because there is no shell to escape for.
 */
export const ArgvParamSchema = z.strictObject({
  flag: z.string().min(1).max(64),
  valuePattern: z.string().min(1).max(256),
  required: z.boolean(),
});

export const ArgvSchemaSchema = z.strictObject({
  id: IdSchema,
  params: z.array(ArgvParamSchema),
});
export type ArgvSchema = z.infer<typeof ArgvSchemaSchema>;

export const RegisteredScriptSchema = z.strictObject({
  executorId: IdSchema,
  path: z.string().min(1).max(1024),
  identity: z.strictObject({
    kind: z.enum(["sha256", "release"]),
    value: z.string().min(1).max(256),
  }),
  argvSchema: ArgvSchemaSchema,
  /** The only directory the child is given. Never the daemon's cwd. */
  cwd: z.string().min(1).max(1024),
  /** The COMPLETE child environment. Nothing is inherited. */
  environmentProfile: z.record(z.string().max(128), z.string().max(4096)),
  timeoutMs: z.number().int().positive().max(3_600_000),
  maxOutputBytes: z.number().int().positive().max(10_000_000),
  /** The file must be owned by this exact uid. Ownership is never inferred. */
  expectedOwnerUid: z.number().int().nonnegative(),
});
export type RegisteredScript = z.infer<typeof RegisteredScriptSchema>;

export type IdentityCheck =
  | { ok: true }
  | { ok: false; reason: string; actual?: string };

export class ScriptRegistry {
  readonly #byId: Map<string, RegisteredScript>;

  private constructor(byId: Map<string, RegisteredScript>) {
    this.#byId = byId;
  }

  static load(scripts: unknown[]): ScriptRegistry {
    const byId = new Map<string, RegisteredScript>();
    for (const raw of scripts) {
      const script = RegisteredScriptSchema.parse(raw);
      if (byId.has(script.executorId)) {
        throw new Error(`duplicate executor id: ${script.executorId}`);
      }
      byId.set(script.executorId, script);
    }
    return new ScriptRegistry(byId);
  }

  get(executorId: string): RegisteredScript | undefined {
    return this.#byId.get(executorId);
  }

  /**
   * Re-hash the file on disk and compare it against the pinned identity.
   *
   * Called immediately before spawn, not at load: a script certified an hour
   * ago and edited since is a different script, and the window that matters is
   * the one between the check and the exec.
   */
  verifyIdentity(script: RegisteredScript): IdentityCheck {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(script.path);
    } catch {
      return { ok: false, reason: "script-missing" };
    }
    if (!stat.isFile()) return { ok: false, reason: "script-not-a-file" };

    // Group- or world-writable means anyone can change what runs next.
    if ((stat.mode & 0o022) !== 0) {
      return { ok: false, reason: "script-writable-by-others" };
    }
    if (stat.uid !== script.expectedOwnerUid) {
      return { ok: false, reason: "script-owner-mismatch" };
    }

    if (script.identity.kind === "release") {
      // No trusted release-identity resolver exists at this boundary. Treat a
      // declaration that cannot be recomputed as unverifiable, never as a
      // successful identity check.
      return { ok: false, reason: "release-identity-unverifiable" };
    }
    const actual = createHash("sha256")
      .update(readFileSync(script.path))
      .digest("hex");
    return actual === script.identity.value
      ? { ok: true }
      : { ok: false, reason: "script-drift", actual };
  }

  /**
   * Validate an argv array element by element.
   *
   * @throws when the argv does not match the declared schema. Every element
   * must be an expected flag or a value matching that flag's anchored pattern;
   * an unexpected element is refused rather than escaped.
   */
  validateArgv(script: RegisteredScript, argv: readonly string[]): void {
    const byFlag = new Map(script.argvSchema.params.map((p) => [p.flag, p]));
    const seen = new Set<string>();

    for (let i = 0; i < argv.length; i += 1) {
      const flag = argv[i];
      const param = byFlag.get(flag);
      if (param === undefined) {
        throw new Error(
          `argument schema ${script.argvSchema.id}: unexpected argument ${JSON.stringify(flag)}`,
        );
      }
      if (seen.has(flag)) {
        throw new Error(
          `argument schema ${script.argvSchema.id}: repeated argument ${flag}`,
        );
      }
      seen.add(flag);

      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(
          `argument schema ${script.argvSchema.id}: ${flag} has no value`,
        );
      }
      if (!new RegExp(`^(?:${param.valuePattern})$`).test(value)) {
        throw new Error(
          `argument schema ${script.argvSchema.id}: value for ${flag} does not match its pattern`,
        );
      }
      i += 1;
    }

    for (const param of script.argvSchema.params) {
      if (param.required && !seen.has(param.flag)) {
        throw new Error(
          `argument schema ${script.argvSchema.id}: missing required ${param.flag}`,
        );
      }
    }
  }
}
