# Next Run Priorities

1. ACF-905 Runtime endpoint ownership map + deprecation switches.
2. ACF-908 Orchestrator minimal loop (`mentioned -> fetch context -> reply`).
3. ACF-909 Thread/session continuity contract.
4. ACF-911 Runtime-first plugin/tooling cutover.
5. ACF-914 Coordination observability + SLOs for inbox/orchestrator.

## Definition of done for next run
- Orchestrator loop running against inbox + stream with bounded policies.
- Runtime-first plugin/tooling defaults are enabled for new sessions.
- Deprecated legacy collaboration reads are behind explicit compatibility switches.
