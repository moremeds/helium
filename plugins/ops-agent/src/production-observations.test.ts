import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ObservationSchema, type Observation } from "@helium/core";
import type { CommandResult, CommandRunner } from "./probes/process.js";
import {
  ProductionObservationTargetsSchema,
  createProductionObservationProbes,
  loadProductionObservationTargets,
} from "./production-observations.js";

const NOW = new Date("2026-08-29T22:50:00.000Z");

const targets = ProductionObservationTargetsSchema.parse({
  version: 1,
  sampleIntervalMs: 300_000,
  ttlMs: 600_000,
  host: {
    volumes: [
      { id: "internal-data", mount: "/System/Volumes/Data", device: "/dev/disk3s5" },
      { id: "data-lake", mount: "/Volumes/DATA_LAKE", device: "/dev/disk4s2" },
    ],
    processArgv: ["/bin/ps", "-Ao", "pid=,command="],
    processMatch: "plugins/ops-agent/lib/bin/opsd.js",
  },
  livewire: {
    statusArgv: ["/opt/livewire/python", "/opt/livewire/livewire_ops.py", "status"],
    integrityFiles: ["/lake/bronze/asset_class=equity/symbol=NULG/1m.parquet"],
    degradedAfterMs: 259_200_000,
    failedAfterMs: 432_000_000,
  },
  argon: {
    healthUrl: "http://127.0.0.1:8400/api/health",
    workerMaxAgeMs: 180_000,
    productMaxAgeMs: 345_600_000,
    backupDir: "/Volumes/DATA_LAKE/argon/postgres-backups",
    backupNamePattern: "option_wizard-*.dump.gz",
    backupMaxAgeMs: 172_800_000,
  },
  apex: {
    healthUrl: "http://127.0.0.1:8322/health",
    pgIsReadyPath: "/opt/postgres/bin/pg_isready",
    postgresHost: "127.0.0.1",
    postgresPort: 5432,
    postgresDatabase: "option_wizard",
    postgresUser: "argon_app",
    silverRevisionPath: "/Volumes/DATA_LAKE/livewire/data-lake/silver/revisions/current.json",
    dataLakeMount: "/Volumes/DATA_LAKE",
    dataLakeDevice: "/dev/disk4s2",
    maxLivewireLagDays: 1,
  },
  colima: {
    dockerPath: "/opt/homebrew/bin/docker",
    socketPath: "/Users/moremeds/.colima/default/docker.sock",
    expectedContainers: ["argon-api-1"],
  },
  postgres: {
    pgIsReadyPath: "/opt/postgres/bin/pg_isready",
    psqlPath: "/opt/postgres/bin/psql",
    host: "127.0.0.1",
    port: 5432,
    database: "option_wizard",
    user: "argon_app",
    selectOneFailedAfterMs: 1_000,
    connectionDegradedRatio: 0.8,
    connectionFailedRatio: 0.95,
    lockFailedAfterMs: 60_000,
    backupDir: "/Volumes/DATA_LAKE/argon/postgres-backups",
    backupNamePattern: "option_wizard-*.dump.gz",
    backupMaxAgeMs: 172_800_000,
    launchOwnerLabel: "com.moremeds.postgresql17-external",
  },
  helium: {
    dshLabel: "com.helium.dsh",
    deadManLabel: "com.helium.deadman",
    heartbeatDir: "/Users/moremeds/.helium/state/jsonl",
    deadManLogPath: "/Users/moremeds/.helium/logs/deadman.out.log",
    globalMaxAgeMs: 180_000,
    collectorMaxAgeMs: 180_000,
    deadManMaxAgeMs: 2_400_000,
    expectedTenantManifestRef: "/Users/moremeds/projects/helium-releases/v0.1.5/jobs",
    expectedTenants: [
      { id: "macro-watch", maxAgeMs: 180_000 },
      { id: "apex-health", maxAgeMs: 180_000 },
      { id: "dsh-canary", maxAgeMs: 46_800_000 },
    ],
  },
});

function reply(stdout: string, ref: string, exitCode = 0): CommandResult {
  return { stdout, exitCode, timedOut: false, evidenceRef: `artifact://raw/${ref}` };
}

function fixtureRunner(options: {
  dockerName?: string;
  argonWorkerAt?: string;
  argonWorkerLagSeconds?: number;
  quietPgIsReady?: boolean;
} = {}) {
  const calls: readonly string[][] = [];
  const runner: CommandRunner = {
    async run(argv) {
      (calls as string[][]).push([...argv]);
      const joined = argv.join(" ");
      if (argv[1] === "/release/scripts/ops/check-parquet-integrity.py") {
        return reply(JSON.stringify({
          checked: 1,
          valid: 0,
          invalid: [{
            path: "/lake/bronze/asset_class=equity/symbol=NULG/1m.parquet",
            reason: "missing trailing PAR1 magic",
          }],
        }), "parquet-integrity");
      }
      if (argv[0] === "/opt/livewire/python") {
        return reply([
          "Livewire status",
          "[BAD ] Intraday catch-up phases:",
          "  daily_backfill_intraday_30m_volatility DEGRADED (IB down)",
          "[BAD ] Coverage:",
          "  2026-08-28 coverage: 1d=2473/13505 (18.31%) 1m=1/14796 (0.01%) 1h=1/14796 (0.01%) 5m=526/14797 (3.55%) 30m=1166/14798 (7.88%)",
        ].join("\n"), "livewire");
      }
      if (argv[0] === "/usr/bin/curl" && joined.includes("8400")) {
        return reply(`${JSON.stringify({
          ok: true,
          db: "up",
          workers: [
            {
              last_beat_at: options.argonWorkerAt ?? "2026-08-29T22:49:50.000Z",
              ...(options.argonWorkerLagSeconds === undefined
                ? {}
                : { lag_seconds: options.argonWorkerLagSeconds }),
            },
            {
              last_beat_at: options.argonWorkerAt ?? "2026-08-29T22:49:45.000Z",
              lag_seconds: options.argonWorkerLagSeconds ?? 15,
            },
          ],
          freshness: { as_of: "2026-08-28" },
        })}\n200`, "argon");
      }
      if (argv[0] === "/usr/bin/curl" && joined.includes("8322")) {
        return reply(`${JSON.stringify({
          status: "ok",
          pg_connected: true,
          livewire: { configured: true, recency: { lag_days: 1 } },
          silver_revision: {
            observed_revision: 37,
            last_fully_applied_revision: 37,
          },
        })}\n200`, "apex");
      }
      if (argv[0] === "/usr/bin/find") {
        return reply(
          "1784748370|20924905444|moremeds|-rwx------|/Volumes/DATA_LAKE/argon/postgres-backups/option_wizard-20260723.dump.gz\n",
          "backup",
        );
      }
      if (argv[0] === "/usr/bin/grep") return reply('"revision":37\n', "revision");
      if (argv[0] === "/bin/df") {
        return reply([
          "Filesystem 1024-blocks Used Available Capacity Mounted on",
          "/dev/disk4s2 13671946368 6594352384 7077593984 49% /Volumes/DATA_LAKE",
        ].join("\n"), "mount");
      }
      if (argv[0] === "/opt/homebrew/bin/docker" && argv[1] === "info") {
        return reply(`${JSON.stringify({
          Name: options.dockerName ?? "colima",
          ServerVersion: "29.2.1",
        })}\n`, "docker-info");
      }
      if (argv[0] === "/opt/homebrew/bin/docker" && argv[1] === "ps") {
        return reply('"argon-api-1"\n', "docker-ps");
      }
      if (argv[0] === "/opt/homebrew/bin/docker" && argv[1] === "inspect") {
        return reply('"/argon-api-1"|0|false\n', "docker-inspect");
      }
      if (argv[0] === "/usr/bin/stat" && joined.includes("docker.sock")) {
        return reply("srw-------|/Users/moremeds/.colima/default/docker.sock\n", "socket");
      }
      if (argv[0] === "/opt/postgres/bin/pg_isready") {
        return reply(options.quietPgIsReady === true ? "" : "accepting connections\n", "ready");
      }
      if (argv[0] === "/opt/postgres/bin/psql" && joined.includes("SELECT 1")) {
        return reply("BEGIN\nSET\n1\nCOMMIT\n", "select-one");
      }
      if (argv[0] === "/opt/postgres/bin/psql") {
        return reply('BEGIN\nSET\n{"used":20,"max":100,"blocked":0,"oldest_ms":0,"bytes":1000000}\nCOMMIT\n', "postgres-stats");
      }
      if (argv[0] === "/bin/launchctl") return reply("state = running\n", "launchd");
      if (argv[0] === "/usr/bin/stat" && joined.includes("deadman.out.log")) {
        return reply("1788043740|15742|/Users/moremeds/.helium/logs/deadman.out.log\n", "deadman-log");
      }
      if (joined.includes("read-latest-heartbeats.mjs")) {
        return reply([
          '{"ts":"2026-08-29T22:49:55.000Z","job":"macro-watch"}',
          '{"ts":"2026-08-29T22:49:50.000Z","job":"apex-health"}',
          '{"ts":"2026-08-29T17:00:00.000Z","job":"dsh-canary"}',
        ].join("\n"), "heartbeats");
      }
      throw new Error(`unexpected argv: ${joined}`);
    },
  };
  return { runner, calls };
}

describe("production observation probes", () => {
  it("loads the committed non-secret Mini target inventory", () => {
    const path = fileURLToPath(new URL("../../../ops/observation-targets.yaml", import.meta.url));
    const loaded = loadProductionObservationTargets(path);
    expect(loaded.colima.expectedContainers).toContain("argon-api-1");
    expect(loaded.helium.expectedTenants.map((tenant) => tenant.id)).toEqual([
      "macro-watch",
      "apex-health",
      "dsh-canary",
    ]);
  });

  it("collects every initial application and database adapter through exact read-only argv", async () => {
    const { runner, calls } = fixtureRunner();
    const probes = createProductionObservationProbes(targets, {
      releaseDir: "/release",
      nodePath: "/usr/local/bin/node",
    });
    const observations = (
      await Promise.all(probes.map((probe) => probe.observe(runner, NOW)))
    ).flatMap((rows) => Array.isArray(rows) ? rows : [rows]);

    ObservationSchema.array().parse(observations);
    expect(new Set(observations.map((row) => row.componentId))).toEqual(
      new Set(["livewire", "argon", "apex", "colima", "postgres", "helium"]),
    );
    expect(observations.every((row) => row.evidenceRefs.every((ref: string) => ref.startsWith("artifact://raw/"))))
      .toBe(true);
    expect(observations.find((row) => row.probeId === "livewire.status-parser.v1")?.state)
      .toBe("failed");
    expect(observations.find((row) => row.probeId === "livewire.parquet-integrity.v1")?.state)
      .toBe("failed");
    expect(observations.find((row) => row.probeId === "argon.backup-freshness.v1")?.state)
      .toBe("failed");
    expect(observations.find((row) => row.probeId === "apex.livewire-revision.v1")?.state)
      .toBe("ok");
    expect(observations.find((row) => row.probeId === "colima.container-inventory.v1")?.state)
      .toBe("ok");
    expect(observations.find((row) => row.probeId === "postgres.backup.v1")?.state)
      .toBe("failed");
    expect(observations.find((row) => row.probeId === "helium.tenant.dsh-canary.v1")?.state)
      .toBe("ok");

    expect(calls.length).toBeGreaterThan(15);
    expect(calls.every((argv) => argv[0]?.startsWith("/"))).toBe(true);
    expect(calls.some((argv) => ["/bin/sh", "/bin/bash", "/bin/zsh"].includes(argv[0] ?? "")))
      .toBe(false);
    expect(calls).toContainEqual([
      "/opt/livewire/python",
      "/release/scripts/ops/check-parquet-integrity.py",
      "--path",
      "/lake/bronze/asset_class=equity/symbol=NULG/1m.parquet",
    ]);
  });

  it("does not rerun expensive application probes before their configured interval", async () => {
    const { runner, calls } = fixtureRunner();
    const [livewire] = createProductionObservationProbes(targets, {
      releaseDir: "/release",
      nodePath: "/usr/local/bin/node",
    });
    await livewire!.observe(runner, NOW);
    const before = calls.length;
    expect(await livewire!.observe(runner, new Date(NOW.getTime() + 60_000))).toEqual([]);
    expect(calls).toHaveLength(before);
  });

  it("does not call an arbitrary reachable Docker daemon the Colima VM", async () => {
    const { runner } = fixtureRunner({ dockerName: "docker-desktop" });
    const probe = createProductionObservationProbes(targets, {
      releaseDir: "/release",
      nodePath: "/usr/local/bin/node",
    }).find((candidate) => candidate.probeId === "colima.production-snapshot.v1")!;
    const observations = await probe.observe(runner, NOW);
    const rows: readonly Observation[] = Array.isArray(observations)
      ? observations
      : [observations];
    expect(rows.find((row) => row.probeId === "colima.vm-state.v1")?.state)
      .toBe("unknown");
  });

  it("uses the service-reported worker lag when the heartbeat was emitted after collection began", async () => {
    const { runner } = fixtureRunner({
      argonWorkerAt: "2026-08-29T22:50:00.250Z",
      argonWorkerLagSeconds: 0.2,
    });
    const probe = createProductionObservationProbes(targets, {
      releaseDir: "/release",
      nodePath: "/usr/local/bin/node",
    }).find((candidate) => candidate.probeId === "argon.production-snapshot.v1")!;
    const observations = await probe.observe(runner, NOW);
    const rows: readonly Observation[] = Array.isArray(observations)
      ? observations
      : [observations];
    expect(rows.find((row) => row.probeId === "argon.worker-heartbeat.v1")?.state)
      .toBe("ok");
  });

  it("treats a quiet successful pg_isready as independent Apex verification", async () => {
    const { runner } = fixtureRunner({ quietPgIsReady: true });
    const probe = createProductionObservationProbes(targets, {
      releaseDir: "/release",
      nodePath: "/usr/local/bin/node",
    }).find((candidate) => candidate.probeId === "apex.production-snapshot.v1")!;
    const observations = await probe.observe(runner, NOW);
    const rows: readonly Observation[] = Array.isArray(observations)
      ? observations
      : [observations];
    expect(rows.find((row) => row.probeId === "apex.postgres-dependency.v1")?.state)
      .toBe("ok");
  });

  it("checks configured Parquet footer structure without reading the data body", () => {
    const root = mkdtempSync(join(tmpdir(), "helium-parquet-integrity-"));
    try {
      const valid = join(root, "valid.parquet");
      const truncated = join(root, "truncated.parquet");
      writeFileSync(valid, Buffer.concat([
        Buffer.from("PAR1"),
        Buffer.alloc(4),
        Buffer.from("PAR1"),
      ]));
      writeFileSync(truncated, "PAR1truncated");
      const script = fileURLToPath(new URL(
        "../../../scripts/ops/check-parquet-integrity.py",
        import.meta.url,
      ));
      const result = spawnSync("/usr/bin/python3", [
        script,
        "--path",
        valid,
        "--path",
        truncated,
      ], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        checked: 2,
        valid: 1,
        invalid: [{ path: truncated, reason: "missing trailing PAR1 magic" }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
