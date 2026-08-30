import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  ContentAddressedArtifactStore,
  type EcosystemTool,
  type TeamManifest,
} from "@helium/core";
import { z } from "zod";

const execFile = promisify(execFileCallback);
const HttpUrlSchema = z.string().min(1).superRefine((value, ctx) => {
  try {
    const protocol = new URL(value).protocol;
    if (protocol === "http:" || protocol === "https:") return;
  } catch {
    // The issue below is the stable public error for both malformed and non-HTTP URLs.
  }
  ctx.addIssue({ code: "custom", message: "source URL must use HTTP(S)" });
});
const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export type SourceContentKind = "raw-source" | "search-snippet";

export interface RawSourceResult {
  sourceUrl: string;
  raw: string | Uint8Array;
  normalized: unknown;
  contentKind: SourceContentKind;
}

export interface AnySearchPort {
  search(input: { query: string; limit: number }): Promise<RawSourceResult>;
  extract(input: { url: string }): Promise<RawSourceResult>;
}

export interface LivewireSourcePort {
  read(input: {
    source: "massive" | "ib";
    request: Record<string, unknown>;
  }): Promise<RawSourceResult | { state: "AWAITING_USER" | "AWAITING_PROVIDER"; reason: string }>;
}

export interface DeterministicShepherdPort {
  eligible(input: { workUnitId: string; scopeHash: string }): Promise<{
    operations: string[];
    evidenceRefs: Array<{ ref: string; hash: string }>;
  }>;
  probe(input: { workUnitId: string; probeId: string }): Promise<RawSourceResult>;
}

interface OpenCliArgument {
  name: string;
  type: string;
  required: boolean;
  positional: boolean;
}

interface OpenCliCommand {
  command: string;
  access: "read" | "write";
  browser: boolean;
  args: OpenCliArgument[];
}

export interface OpenCliReadPort {
  read(input: { command: string; arguments: Record<string, string | number | boolean> }): Promise<
    RawSourceResult | { state: "AWAITING_PROVIDER"; reason: string }
  >;
}

type OpenCliExec = (argv: string[]) => Promise<{ stdout: string; stderr: string }>;

export class OpenCliReadAdapter implements OpenCliReadPort {
  readonly #allowedCommands: Set<string>;
  readonly #binary: string;
  readonly #timeoutMs: number;
  readonly #exec: OpenCliExec;

  constructor(options: {
    allowedCommands: string[];
    binary?: string;
    timeoutMs?: number;
    exec?: OpenCliExec;
  }) {
    if (options.allowedCommands.length === 0) throw new Error("OpenCLI requires an explicit read-command allowlist");
    this.#allowedCommands = new Set(options.allowedCommands);
    if (this.#allowedCommands.size !== options.allowedCommands.length) throw new Error("duplicate OpenCLI command");
    this.#binary = options.binary ?? "opencli";
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#exec = options.exec ?? (async (argv) => await execFile(this.#binary, argv, {
      timeout: this.#timeoutMs,
      maxBuffer: 10_000_000,
    }));
  }

  async read(input: { command: string; arguments: Record<string, string | number | boolean> }) {
    if (!this.#allowedCommands.has(input.command)) {
      throw new Error(`OpenCLI command is not configured: ${input.command}`);
    }
    const catalog = await this.#catalog();
    const command = catalog.find((candidate) => candidate.command === input.command);
    if (command === undefined) throw new Error(`OpenCLI command is absent from live catalog: ${input.command}`);
    assertSafeReadCommand(command);
    if (command.browser) {
      const doctor = await this.#exec(["doctor"]);
      if (/Extension:\s+unstable|extension disconnected/i.test(`${doctor.stdout}\n${doctor.stderr}`)) {
        return { state: "AWAITING_PROVIDER" as const, reason: "opencli-browser-bridge-unstable" };
      }
    }
    const argv = buildOpenCliArguments(command, input.arguments);
    const result = await this.#exec([input.command, ...argv, "-f", "json"]);
    const raw = result.stdout;
    let normalized: unknown;
    try {
      normalized = JSON.parse(raw);
    } catch (error) {
      throw new Error("OpenCLI read did not return JSON", { cause: error });
    }
    const sourceUrl = firstHttpUrl(normalized);
    if (sourceUrl === undefined) throw new Error("OpenCLI result has no source URL");
    return { sourceUrl, raw, normalized, contentKind: "raw-source" as const };
  }

  async #catalog(): Promise<OpenCliCommand[]> {
    const result = await this.#exec(["list", "-f", "json"]);
    const parsed = z.array(z.strictObject({
      command: z.string().min(1),
      access: z.enum(["read", "write"]),
      browser: z.boolean(),
      args: z.array(z.object({
        name: z.string().min(1),
        type: z.string().min(1),
        required: z.boolean(),
        positional: z.boolean(),
      }).passthrough()),
    }).passthrough()).parse(JSON.parse(result.stdout));
    return parsed;
  }
}

const ForbiddenOpenCliArgument = /^(?:execute|file|output|include-sensitive|download-images)$/;
const UnsafeReadCommand = /\/(?:download|export|login|open|play)$/;

function assertSafeReadCommand(command: OpenCliCommand): void {
  if (command.access !== "read") throw new Error(`OpenCLI command is not read-only: ${command.command}`);
  if (UnsafeReadCommand.test(command.command)) throw new Error(`OpenCLI command may change local or remote state: ${command.command}`);
  const unsafe = command.args.find((argument) => ForbiddenOpenCliArgument.test(argument.name));
  if (unsafe !== undefined) throw new Error(`OpenCLI command exposes unsafe argument: ${unsafe.name}`);
}

function buildOpenCliArguments(
  command: OpenCliCommand,
  input: Record<string, string | number | boolean>,
): string[] {
  const known = new Map(command.args.map((argument) => [argument.name, argument]));
  const unknown = Object.keys(input).find((name) => !known.has(name));
  if (unknown !== undefined) throw new Error(`unknown OpenCLI argument: ${unknown}`);
  const argv: string[] = [];
  for (const argument of command.args) {
    const value = input[argument.name];
    if (value === undefined) {
      if (argument.required) throw new Error(`missing OpenCLI argument: ${argument.name}`);
      continue;
    }
    if (argument.type === "boolean" || argument.type === "bool") {
      if (typeof value !== "boolean") throw new Error(`OpenCLI argument ${argument.name} must be boolean`);
      if (value && !argument.positional) argv.push(`--${argument.name}`);
      continue;
    }
    if (argument.type === "int" && (typeof value !== "number" || !Number.isSafeInteger(value))) {
      throw new Error(`OpenCLI argument ${argument.name} must be an integer`);
    }
    if (argument.positional) argv.push(String(value));
    else argv.push(`--${argument.name}`, String(value));
  }
  return argv;
}

function firstHttpUrl(value: unknown): string | undefined {
  if (typeof value === "string") return HttpUrlSchema.safeParse(value).success ? value : undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = firstHttpUrl(entry);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  for (const [key, entry] of Object.entries(value)) {
    if (/^(?:url|link|sourceUrl|source_url)$/i.test(key) && typeof entry === "string") {
      const parsed = HttpUrlSchema.safeParse(entry);
      if (parsed.success) return parsed.data;
    }
    const found = firstHttpUrl(entry);
    if (found !== undefined) return found;
  }
  return undefined;
}

const QuerySchema = z.strictObject({
  query: z.string().min(1).max(2_000),
  limit: z.number().int().positive().max(50).default(10),
});
const ExtractSchema = z.strictObject({ url: HttpUrlSchema });
const SourceReadSchema = z.strictObject({ request: z.record(z.string(), z.unknown()) });
const EvidenceReadSchema = z.strictObject({ ref: z.string().min(1), hash: HashSchema });
const EligibleSchema = z.strictObject({ workUnitId: z.string().min(1), scopeHash: HashSchema });
const ProbeSchema = z.strictObject({ workUnitId: z.string().min(1), probeId: z.string().min(1) });
const OpenCliSchema = z.strictObject({
  command: z.string().min(1),
  arguments: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

export function buildShepherdTeamTools(options: {
  artifacts: ContentAddressedArtifactStore;
  anySearch: AnySearchPort;
  livewire: LivewireSourcePort;
  deterministic: DeterministicShepherdPort;
  openCli: OpenCliReadPort;
  now?: () => Date;
  maxAgentBytes?: number;
}): EcosystemTool[] {
  const now = options.now ?? (() => new Date());
  const maxAgentBytes = options.maxAgentBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(maxAgentBytes) || maxAgentBytes < 1_024) {
    throw new Error("Shepherd agent result bound must be at least 1024 bytes");
  }
  const preserve = (result: RawSourceResult) => preserveSource(result, options.artifacts, now(), maxAgentBytes);
  const sourceTool = (
    name: string,
    source: "massive" | "ib",
  ): EcosystemTool => ({
    name,
    description: `Read ${source} through the strict Livewire bridge and preserve raw evidence.`,
    paramsSchema: SourceReadSchema,
    mutating: false,
    run: async (args) => {
      const input = SourceReadSchema.parse(args);
      const result = await options.livewire.read({ source, request: input.request });
      return JSON.stringify("state" in result ? result : preserve(result));
    },
  });
  return [
    {
      name: "livewire.evidence.read",
      description: "Read and verify one immutable Shepherd evidence artifact.",
      paramsSchema: EvidenceReadSchema,
      mutating: false,
      run: async (args) => {
        const input = EvidenceReadSchema.parse(args);
        const stored = options.artifacts.verify(input.ref, input.hash);
        const content = boundedContent(options.artifacts.read(input.ref).toString("utf8"), maxAgentBytes);
        return JSON.stringify({ ...stored, ...content });
      },
    },
    sourceTool("livewire.massive.read", "massive"),
    sourceTool("livewire.ib.observe", "ib"),
    {
      name: "anysearch.search",
      description: "Search for candidate sources. Snippets are discovery evidence only.",
      paramsSchema: QuerySchema,
      mutating: false,
      run: async (args) => {
        const input = QuerySchema.parse(args);
        const result = await options.anySearch.search(input);
        if (result.contentKind !== "search-snippet") throw new Error("AnySearch search must return discovery snippets");
        return JSON.stringify(preserve(result));
      },
    },
    {
      name: "anysearch.extract",
      description: "Extract exact source content from an HTTP(S) URL and preserve raw bytes.",
      paramsSchema: ExtractSchema,
      mutating: false,
      run: async (args) => {
        const result = await options.anySearch.extract(ExtractSchema.parse(args));
        if (result.contentKind !== "raw-source") throw new Error("AnySearch extraction must return raw source content");
        return JSON.stringify(preserve(result));
      },
    },
    {
      name: "opencli.read",
      description: "Run one configured OpenCLI read adapter and preserve its raw JSON response.",
      paramsSchema: OpenCliSchema,
      mutating: false,
      run: async (args) => {
        const result = await options.openCli.read(OpenCliSchema.parse(args));
        return JSON.stringify("state" in result ? result : preserve(result));
      },
    },
    {
      name: "livewire.repair.eligible",
      description: "List deterministic operations eligible for one exact Shepherd scope; does not execute them.",
      paramsSchema: EligibleSchema,
      mutating: false,
      run: async (args) => JSON.stringify(await options.deterministic.eligible(EligibleSchema.parse(args))),
    },
    {
      name: "livewire.probe.request",
      description: "Request a configured deterministic verification probe and preserve raw evidence.",
      paramsSchema: ProbeSchema,
      mutating: false,
      run: async (args) => JSON.stringify(preserve(await options.deterministic.probe(ProbeSchema.parse(args)))),
    },
  ];
}

function preserveSource(
  input: RawSourceResult,
  artifacts: ContentAddressedArtifactStore,
  retrievalTime: Date,
  maxAgentBytes: number,
) {
  const sourceUrl = HttpUrlSchema.parse(input.sourceUrl);
  const bytes = Buffer.isBuffer(input.raw) ? input.raw : Buffer.from(input.raw);
  if (bytes.length === 0) throw new Error("source result has no raw bytes");
  const evidence = artifacts.put(bytes);
  return {
    sourceUrl,
    retrievalTime: retrievalTime.toISOString(),
    contentKind: input.contentKind,
    evidence,
    normalized: boundedNormalized(input.normalized, maxAgentBytes),
  };
}

function boundedNormalized(value: unknown, maxBytes: number): unknown {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) <= maxBytes) return value;
  return {
    truncated: true,
    preview: encoded.slice(0, maxBytes),
    originalBytes: Buffer.byteLength(encoded),
  };
}

function boundedContent(content: string, maxBytes: number) {
  if (Buffer.byteLength(content) <= maxBytes) return { content, truncated: false };
  return {
    content: content.slice(0, maxBytes),
    truncated: true,
    originalBytes: Buffer.byteLength(content),
  };
}

export function toolsForShepherdRole(
  manifest: TeamManifest,
  role: string,
  catalog: readonly EcosystemTool[],
): EcosystemTool[] {
  const allowed = manifest.roles[role]?.permissions.tools;
  if (allowed === undefined) throw new Error(`unknown Shepherd role: ${role}`);
  const byName = new Map(catalog.map((tool) => [tool.name, tool]));
  return allowed.map((name) => {
    const tool = byName.get(name);
    if (tool === undefined) throw new Error(`configured Shepherd tool is unavailable: ${name}`);
    if (tool.mutating) throw new Error(`Shepherd role cannot receive mutating tool: ${name}`);
    return tool;
  });
}
