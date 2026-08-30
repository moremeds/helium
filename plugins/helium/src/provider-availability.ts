import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  AvailabilitySchema,
  type AgentResult,
  type Availability,
  type CapabilityCatalog,
  type ExecutionTargetId,
} from "@helium/core";

export interface ProviderAvailabilitySnapshot {
  version: string;
  domains: Array<{
    quotaDomain: string;
    targets: string[];
    availability: Availability;
  }>;
}

export class ProviderAvailability {
  readonly #domains = new Map<string, ExecutionTargetId[]>();
  readonly #states = new Map<string, Availability>();
  readonly #targetDomains = new Map<string, string>();
  readonly #statePath: string;
  readonly #sync: (fd: number) => void;

  constructor(
    private readonly capabilities: CapabilityCatalog,
    options: { statePath: string; sync?: (fd: number) => void },
  ) {
    this.#statePath = options.statePath;
    this.#sync = options.sync ?? fsyncSync;
    if (existsSync(this.#statePath)) {
      const parsed = JSON.parse(readFileSync(this.#statePath, "utf8")) as {
        version?: unknown;
        states?: unknown;
      };
      if (parsed.version !== 1 || typeof parsed.states !== "object" || parsed.states === null) {
        throw new Error("invalid provider availability state");
      }
      for (const [domain, state] of Object.entries(parsed.states)) {
        if (domain.trim() === "") throw new Error("invalid persisted quota domain");
        this.#states.set(domain, AvailabilitySchema.parse(state));
      }
    }
  }

  registerDomain(quotaDomain: string, targets: ExecutionTargetId[]): () => void {
    if (quotaDomain.trim() === "") throw new Error("quota domain must not be empty");
    if (this.#domains.has(quotaDomain)) {
      throw new Error(`duplicate quota domain: ${quotaDomain}`);
    }
    const unique = new Set(targets.map(String));
    if (unique.size !== targets.length || targets.length === 0) {
      throw new Error(`quota domain ${quotaDomain} needs unique targets`);
    }
    for (const target of targets) {
      if (this.capabilities.get(target) === undefined) {
        throw new Error(`quota domain names unknown target: ${target}`);
      }
      const owner = this.#targetDomains.get(String(target));
      if (owner !== undefined) {
        throw new Error(`target ${target} already belongs to quota domain ${owner}`);
      }
    }
    this.#domains.set(quotaDomain, [...targets]);
    const state = this.#states.get(quotaDomain) ?? { state: "available" as const };
    this.#states.set(quotaDomain, state);
    for (const target of targets) {
      this.#targetDomains.set(String(target), quotaDomain);
      this.capabilities.setAvailability(target, state);
    }
    return () => {
      this.#domains.delete(quotaDomain);
      for (const target of targets) this.#targetDomains.delete(String(target));
    };
  }

  publish(
    quotaDomain: string,
    input: Availability,
  ): { changed: boolean; snapshot: ProviderAvailabilitySnapshot } {
    const targets = this.#domains.get(quotaDomain);
    if (targets === undefined) throw new Error(`unknown quota domain: ${quotaDomain}`);
    const availability = AvailabilitySchema.parse(input);
    const previous = this.#states.get(quotaDomain);
    if (JSON.stringify(previous) === JSON.stringify(availability)) {
      return { changed: false, snapshot: this.snapshot() };
    }
    for (const target of targets) {
      if (this.capabilities.get(target) === undefined) {
        throw new Error(`quota domain target was disposed: ${target}`);
      }
    }
    const next = new Map(this.#states);
    next.set(quotaDomain, availability);
    this.#persist(next);
    for (const target of targets) {
      this.capabilities.setAvailability(target, availability);
    }
    this.#states.set(quotaDomain, availability);
    return { changed: true, snapshot: this.snapshot() };
  }

  observe(result: AgentResult): {
    changed: boolean;
    snapshot: ProviderAvailabilitySnapshot;
  } {
    const domain = this.#targetDomains.get(String(result.executionSnapshot.targetId));
    if (domain === undefined || result.failure?.class !== "quota-exhausted") {
      return { changed: false, snapshot: this.snapshot() };
    }
    return this.publish(domain, {
      state: "quota-exhausted",
      ...(result.failure.retryAfter === undefined
        ? {}
        : { retryAfter: result.failure.retryAfter }),
    });
  }

  snapshot(): ProviderAvailabilitySnapshot {
    const domains = [...this.#domains]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([quotaDomain, targets]) => ({
        quotaDomain,
        targets: targets.map(String).sort(),
        availability: this.#states.get(quotaDomain) ?? { state: "available" as const },
      }));
    const version = createHash("sha256")
      .update(JSON.stringify(domains))
      .digest("hex");
    return { version: `availability-${version}`, domains };
  }

  #persist(states: Map<string, Availability>): void {
    const parent = dirname(this.#statePath);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const body = `${JSON.stringify({
      version: 1,
      states: Object.fromEntries([...states].sort(([a], [b]) => a.localeCompare(b))),
    })}\n`;
    const temporary = `${this.#statePath}.${process.pid}.tmp`;
    const fd = openSync(temporary, "w", 0o600);
    try {
      writeFileSync(fd, body, "utf8");
      this.#sync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.#statePath);
    chmodSync(this.#statePath, 0o600);
    const dirFd = openSync(parent, "r");
    try {
      this.#sync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }
}
