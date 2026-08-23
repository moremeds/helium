# dsh spike evidence (2026-08-23, dsh 0.1.1-rc.2)

Throwaway spike code preserved as **API ground truth** for helium implementation.
Copy dsh API usage from here; never invent a dsh API that is not demonstrated
here or verifiable in the installed dsh source.

| file | what it proves |
|---|---|
| `plugin-index.ts` | Working cordis plugin: `ctx.effect()` interval timer; `ctx.agents.create()` (SessionId, installModelSelection); `agent.followup(createUserMessage(...))`; `whenIdle()`; `ctx.sessions.flush()`; session-event watermark capture (`session.seq` + scan `assistant/message` above it) |
| `plugin-package.json` | Plugin packaging: ESM, `main: ./lib/index.js`, `dsh.bundle.patch` pointing at the bundle patch |
| `plugin-tsconfig.json` | Compiled-JS requirement: ES2023 / NodeNext, `outDir: lib` (dsh cannot load TS under node_modules) |
| `plugin-cordis.patch.yml` | Bundle patch format (`- insert:` with id/name/config; `!!js` env expressions) |
| `profile-sensor/` | Profile layout under `$DSH_HOME/profiles/<name>/`: `cordis.yml` (empty root), `cordis.patch.yml`, `package.json` with `dsh.profile.bundles` + `file:` dependency (never `link:`) |
| `pysdk-sensor.py` | Escape hatch: the same sensor loop on the dsh Python SDK in 73 lines (`session.run()` → `final_response`) |

Spike results: 11/11 dispatches completed against real argon `/api/health`,
2.0–3.2 s per `deepseek-v4-flash` analysis, zero errors.
