## Unreleased

The email delivery channel now sends via the Resend API instead of SMTP:
configure `RESEND_HELIUM_TOKEN`, optionally `HELIUM_EMAIL_FROM` (default sender
`Helium <helium@rsiarc.com>`); the `SMTP_*` variables are no longer read.
Sends carry `Idempotency-Key` `<tenant>/<runId>` so a retried timeout cannot
duplicate a briefing, and a 4xx other than 429 fails immediately instead of
retrying a body the API already rejected.

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
