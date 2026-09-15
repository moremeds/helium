M3 task 1: implement a tenant-neutral campaign retention contract, focused
offline regression tests, and M2 diagnostic closeout. No live calls, merge, or
deployment.

Checks: `pnpm vitest run --project unit plugins/helium-self/tests/campaign.spec.ts`
and `pnpm --filter dsh-plugin-tenant-helium-self typecheck`.

Verification completed after building @helium/core: campaign unit tests 2/2, helium-self typecheck clean, diff check clean.
