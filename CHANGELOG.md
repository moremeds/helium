## v0.2.0 — 2026-09-02

v2: delete v1, rebuild the core on dsh (M0+M1). The job/ops/SOP lanes,
5 launchd plists, the accepted-claim ledger and all lease/authority
machinery are gone (57,792 -> 8,455 TS lines). Core now has provider,
tenant, team, work, budget, audit, capability-router and sandbox nouns;
two subscription providers (Claude, Codex) speak HTTP directly through
curl, discoverable and routable by capability with no model named in
core; a SQLite span table backs the token/cost audit query; `helium run
<tenant>` executes `fake-tenant` end to end. No tenant plugin ships yet
(option-wizard is M2) and nothing is deployed to the mini.
