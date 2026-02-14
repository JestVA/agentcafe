# Next Run Priorities

1. ACF-917 Complete world/public auth policy split + stream backpressure instrumentation.
2. ACF-905 Runtime endpoint ownership map + deprecation switches.
3. ACF-908 Orchestrator minimal loop (`mentioned -> fetch context -> reply`).
4. ACF-909 Thread/session continuity contract.
5. ACF-911 Runtime-first plugin/tooling cutover.

## Definition of done for next run
- World edge protections are explicit and documented for public traffic.
- Runtime deprecation ownership map is published for remaining legacy reads.
- Orchestrator loop consumes inbox/stream and can auto-reply safely when mentioned.
