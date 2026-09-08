# Flash pickup: actual-page evidence

These are local examples and compatibility checks, not a production release,
an accepted positive calibration set, or a model comparison. No email or Argon
production write occurred. The local HTTP adapter serves the real channel
payload to the real Next routes without a database.

| Phase | What was executed | Run ID | Source code |
| --- | --- | --- | --- |
| Premarket, Sep 3 | Fresh model replay on recorded inputs | `run-fb84b6fd-68e5-48e3-aefc-7e4da8e0ee33` | `18a953a` |
| Weekly, Sep 6 | Saved new market-author output, rerendered through fixed producer | `run-26422c3b-5e24-47dc-877d-37d66305f680` | Author ran on dirty `a754b01`; renderer `18a953a` |
| Intraday, Sep 3 | Historical C output, current-renderer compatibility only | `run-470da90d-3b26-4580-b55d-f4cd045a3e9f` | Author `d4e9876`; renderer `18a953a` |
| Close, Sep 4 | Historical C output, current-renderer compatibility only | `run-b1abafe8-9912-4ef3-a997-c576c9f65588` | Author `d4e9876`; renderer `18a953a` |

Each phase directory contains `steps.json` with the final `view`, its own raw
`tool-io/`, the exported `payload.json`, and `page/` with visible `page.md`, HTML,
desktop/mobile screenshots and `capture.json`. The capture identifies the Argon
commit, run ID, source-file hash and canonical view hash. `renderedFrom` identifies
rerendered outputs separately and includes the executed plugin-build hash. The
weekly `author-run.json` preserves the pre-fix view and actual assembled prompts.
No subsequent rendering changes the original model/gate outcome.

## Checks performed

- Helium unit suite: 1,119 passed, 3 skipped after the final narrow meta-leak
  correction. Full workspace build passed.
- `node --test scripts/flash-render-saved.test.mjs` passes: failed/degraded states
  survive, Git provenance comes from the renderer repository even when invoked
  elsewhere, existing output cannot be replaced, and the channel payload contains
  the identical view without any network delivery.
- Argon focused Flash tests: 36 passed. TypeScript and lint pass.
- Real routes for all four phases render with matching run ID and view digest.
  Desktop at 1440px and mobile at 390px were captured; mobile horizontal overflow
  is zero for each. Only ancestor scroll-container heights are expanded while
  taking the full article screenshot; article content/width and closed details
  are unchanged. Visible text is captured before that screenshot-only expansion.
- Negative capture check: a changed view with the same run ID is refused with
  `page view does not match source`.
- 73 raw recordings across these four archives were checked against `rawSha256`.
  Payload/view/source/capture hashes aligned; a credential-pattern scan of plain
  artifacts and decompressed recordings found no credential-like values.

## What the pages do not prove

Premarket has no deterministic session frame and lacks current Treasury, credit,
volatility, rotation and dealer-positioning readings. It says so. The available
policy path and prior-session flow do not establish coverage of missing news or
calendar events. The historical daily samples include refusals and cannot prove
the previously omitted AVGO/SNOW/Waller events were recovered.

Weekly has market prose, but its snapshot contains old caps and data gaps. Its
failed empty attempts and original `flash-budget` refusal remain visible. The
fresh daily also retains its original quota failures and advisory refusals; a
subsequent narrow meta-leak fix must not retroactively erase those records.

Intraday and close retain old C author prose, including legacy self-review and
unsupported narratives. They prove rendering compatibility, **not** the new
editorial standard, and are not offered as positive examples. Old live C inputs
are not interchangeable with the nominal frozen daily sample.

The weekly run reports 132,242 input+output tokens and $0.03128; the fresh daily
reports 87,152 tokens and $0.00 in the audit. These are recorded provider-accounting
values, not total billing estimates: subscription-routed calls report zero.

The next acceptance step is human reading of weekly and premarket, followed by
positive/negative reviewer calibration on the exact corresponding inputs. The
third scoring batch, any claim of a model winner, merge/deploy and the production
shadow week remain unperformed.

## Reproduce without new models or delivery

From the Helium checkout, after building:

```sh
pnpm build
node --test scripts/flash-render-saved.test.mjs
# Use a fresh directory; the script will not replace an existing output.
node scripts/flash-render-saved.mjs docs/evidence/flash-pickup/2026-09-08/weekly/steps.json /tmp/flash-rerender-example
node scripts/flash-page-payload.mjs /tmp/flash-rerender-example/steps.json /tmp/flash-example-payload.json
```

From the companion Argon checkout's `web/`, using its installed dependencies:

```sh
node tests/e2e/flash-fixture-server.mjs /tmp/flash-example-payload.json
# In a second terminal; webpack supports the shared worktree node_modules link.
NEXT_INTERNAL_API_BASE=http://127.0.0.1:18407 node node_modules/next/dist/bin/next dev --webpack --port 3107
# In a third terminal:
node scripts/capture-flash.mjs http://localhost:3107/flash/2026-W36 /tmp/flash-rerender-example/steps.json /tmp/flash-example-page
```

To inspect all archived examples, serve the four archived `payload.json` paths
instead. Weekly is `/flash/2026-W36`; daily routes are
`/flash/2026-W36/2026-09-03?phase=premarket`, the same day with `phase=intraday`,
and `/flash/2026-W36/2026-09-04?phase=close`.
