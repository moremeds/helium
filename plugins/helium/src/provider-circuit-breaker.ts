/** Provider-owned consecutive-failure circuit breaker; core remains opaque. */
import { randomUUID } from "node:crypto";
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
import type { AgentResult } from "@helium/core";

export type CircuitProvider = "codex" | "deepseek" | "claude";

interface CircuitState {
  consecutiveFailures: number;
  state: "closed" | "open";
}

export interface ProviderCircuitSnapshot extends CircuitState {
  provider: CircuitProvider;
}

const COUNTED_FAILURES = new Set([
  "provider-error",
  "timeout",
  "unavailable",
  "auth-error",
]);

export class ProviderCircuitBreaker {
  readonly #states = new Map<CircuitProvider, CircuitState>();

  constructor(
    private readonly options: {
      statePath: string;
      failureThreshold: number;
      onOpen(provider: CircuitProvider): void;
      onChange?(snapshot: ProviderCircuitSnapshot[]): void;
    },
  ) {
    if (!Number.isSafeInteger(options.failureThreshold) || options.failureThreshold < 1) {
      throw new Error("provider circuit failure threshold must be a positive integer");
    }
    if (existsSync(options.statePath)) {
      const raw = JSON.parse(readFileSync(options.statePath, "utf8")) as {
        version?: unknown;
        providers?: Record<string, unknown>;
      };
      if (raw.version !== 1 || raw.providers === undefined) {
        throw new Error("invalid provider circuit state");
      }
      for (const provider of ["codex", "deepseek", "claude"] as const) {
        const value = raw.providers[provider] as Partial<CircuitState> | undefined;
        if (value === undefined) continue;
        if (
          !Number.isSafeInteger(value.consecutiveFailures)
          || (value.consecutiveFailures ?? -1) < 0
          || (value.state !== "closed" && value.state !== "open")
        ) {
          throw new Error(`invalid provider circuit state: ${provider}`);
        }
        this.#states.set(provider, value as CircuitState);
      }
    }
  }

  observe(provider: CircuitProvider, result: AgentResult): void {
    if (result.outcome === "completed") {
      this.reset(provider);
      return;
    }
    if (!COUNTED_FAILURES.has(result.failure?.class ?? "")) return;
    const current = this.#states.get(provider) ?? {
      consecutiveFailures: 0,
      state: "closed" as const,
    };
    if (current.state === "open") return;
    const consecutiveFailures = current.consecutiveFailures + 1;
    const next: CircuitState = {
      consecutiveFailures,
      state: consecutiveFailures >= this.options.failureThreshold ? "open" : "closed",
    };
    this.#states.set(provider, next);
    this.#persist();
    this.options.onChange?.(this.snapshot());
    if (next.state === "open") this.options.onOpen(provider);
  }

  reset(provider: CircuitProvider): void {
    const current = this.#states.get(provider);
    if (current?.state === "closed" && current.consecutiveFailures === 0) return;
    this.#states.set(provider, { consecutiveFailures: 0, state: "closed" });
    this.#persist();
    this.options.onChange?.(this.snapshot());
  }

  snapshot(): ProviderCircuitSnapshot[] {
    return [...this.#states]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, state]) => ({ provider, ...state }));
  }

  #persist(): void {
    const parent = dirname(this.options.statePath);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const temporary = `${this.options.statePath}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify({
        version: 1,
        providers: Object.fromEntries(this.#states),
      })}\n`, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.options.statePath);
    chmodSync(this.options.statePath, 0o600);
    const dirFd = openSync(parent, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }
}
