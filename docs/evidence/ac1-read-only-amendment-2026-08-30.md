# AC#1 bounded read-only inspection amendment

**Recorded:** 2026-08-30 Asia/Hong_Kong  
**Authority:** operator decision  
**Applies to:** the active v1 AC#1 observation window ending 2026-08-31

AC#1 measures five consecutive trading days of unattended **v1 workload**
operation. It is not a zero-process host-presence test. The original v1 plan
already specifies a daily SSH heartbeat check. The operator has therefore
superseded the later Ops-plan restriction that prohibited every remotely
started read-only process.

During the remainder of AC#1, a bounded SSH session may read:

- host identity and clock;
- running-process and launchd metadata;
- existing plist and configuration content;
- file paths, owners, modes and cryptographic hashes; and
- immutable-release links and targets.

It may not:

- write, copy or render application, release, configuration, log or state data;
- install or upgrade software;
- deploy Helium or install/start `opsd`;
- invoke a Helium/DSH workload, production probe, SOP or repair script;
- start, stop, restart, enable, disable or reconfigure a managed service; or
- alter launchd state.

Incidental SSH/audit accounting produced by the operating system is accepted as
part of observation and is not a v1 workload intervention. The five trading
days, heartbeat continuity, end-to-end email, and no-unexpected-dead-man-alert
acceptance conditions are unchanged. Any installation, ownership handoff or
controlled repair drill still waits until AC#1 is complete and has separate
evidence and approval.
