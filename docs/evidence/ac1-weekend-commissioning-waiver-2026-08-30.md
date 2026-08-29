# AC#1 weekend commissioning waiver

**Recorded:** 2026-08-30 Asia/Hong_Kong  
**Authority:** operator decision  
**Waiver id:** `ops-phase-d-weekend-2026-08-30`

The v1 AC#1 observation has too little workload coverage to justify losing the
weekend Ops commissioning window. The operator therefore decouples a reversible
Ops Phase D observe-only install from AC#1.

Evidence handling is explicit:

- AC#1 is **not credited as PASS** after commissioning begins;
- its original five-trading-day requirement is not rewritten or backfilled;
- Ops Phase D may gather its own observe-only evidence immediately; and
- no Ops recovery or mutation claim inherits evidence from v1 AC#1.

The waiver permits only:

- an immutable Phase D candidate release separate from the selected Helium
  `current` release;
- installer-owned private paths under `/Users/moremeds/.helium/ops`;
- `/Users/moremeds/Library/LaunchAgents/com.helium.opsd.plist`;
- loading `com.helium.opsd` in `observe` mode with the committed empty authority
  manifest; and
- its own socket, logs, observations and append-only events.

It does not permit a Helium release flip, DSH/legacy-controller restart,
SOP grant, ownership handoff, repair, or controlled mutation drill. After a
valid opsd event path exists, it permits one narrowly reversible dead-man
integration: preserve the original `com.helium.deadman.plist`, add only
`HELIUM_OPSD_EXPECTED=1` and the exact opsd event-log path, lint it, and reload
that exact scheduled label. Live preflight found that v0.1.5's selected dead-man
script predates the opsd check. The same preserved-plist rollback therefore also
permits changing only `ProgramArguments[1]` to the tested candidate script at
commit `5637b97` (SHA-256
`f67896b3585f1feb81e3d7889023d92cdba74be0dfefdee3c9ede968f3baeaa2`).
Success requires a real run to emit `opsd fresh:` and exit 0. Rollback restores
the preserved plist and reloads the same label. Opsd rollback is exact-label
`launchctl bootout` followed by the scoped uninstaller; evidence is preserved
before state removal if needed.
