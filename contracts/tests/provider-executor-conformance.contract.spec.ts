/**
 * The subscription providers no longer spawn a vendor CLI, so the process
 * boundary this suite used to assert has nothing left to assert on.
 *
 * `provider-claude-subscription` and `provider-codex-subscription` speak HTTP
 * (design §3.1). The only child process either starts is `curl`, and the
 * properties that used to need a fake CLI and a narrowed PATH are now either
 * structural or covered closer to the code:
 *
 *   - undeclared env cannot reach the provider   -> curl is spawned with an env
 *     containing nothing but the secret-header variables (`curl.test.ts`)
 *   - credentials must not be visible to `ps`    -> `curl.test.ts`
 *   - undeclared tools cannot reach the model    -> no `tools` is ever sent, and
 *     both the executor and `Provider.run` refuse a work order that asks for
 *     one (`executor.test.ts` and `provider.test.ts` in both plugins)
 *   - workspace access                           -> no workspace is passed at all
 *
 * The only other subject, `provider-deepseek-dsh`, ran in-process through dsh
 * and was never graded here; it was deleted 2026-09-02 as a duplicate of
 * `provider-dsh`. Keeping an empty suite would be the ceremony doctrine 6
 * forbids, so the harness (`contracts/harness/execution-boundary.ts`) and its
 * fixtures are retired with this file.
 */
import { describe, it } from "vitest";

describe("provider executor conformance", () => {
  it.skip("retired: no provider spawns a vendor CLI any more", () => {});
});
