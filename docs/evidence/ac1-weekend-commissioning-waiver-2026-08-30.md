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
valid opsd event path exists, it permits a new, narrowly scoped
`com.helium.opsd-deadman` label that reads only the opsd event log and maintains
only its own sentinel under the private ops root. It must not read DSH or tenant
health. Success requires a real run to emit `opsd fresh:` and exit 0.

An attempted reuse of `com.helium.deadman` proved unsafe: v0.1.5 lacked the
opsd check, while pointing it at the candidate script also enabled a newer
tenant policy and sent one `dsh-canary` missing alert. The original plist was
restored byte-for-byte immediately and exited 0. This legacy label is no longer
part of the opsd integration. Rollback now bootouts only the two new exact labels
(`com.helium.opsd-deadman`, then `com.helium.opsd`) and runs the scoped
uninstaller; evidence is preserved before state removal if needed.
