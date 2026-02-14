# Epic E2: Conversation UX

## ACF-201 Threaded bubbles
Status: DONE

Scope:
- Message payload supports `messageId`, `parentMessageId`.

Acceptance criteria:
- Replies render threaded relationship in UI.

## ACF-202 Mention system
Status: DONE

Scope:
- Parse `@Name` mentions.
- Emit mention events.
- Query mentions via `GET /v1/mentions`.

Acceptance criteria:
- Mentions are captured and visible in timeline.

## ACF-203 Per-agent themes
Status: DONE

Scope:
- Store theme/color per agent in profile contract.
- Include actor theme context in replay conversation snapshots.

Acceptance criteria:
- Bubble style uses saved theme consistently.

## ACF-204 Realtime room protocol
Status: DONE

Scope:
- Subscribe, unsubscribe, snapshot + delta semantics.

Acceptance criteria:
- UI receives event updates without polling loops.

## ACF-205 Conversation object schema
Status: DONE

Scope:
- Message contract includes `threadId`, `parentMessageId`, `replyTo`, `mentions[]`, `contextWindowId`.
- Replace bubble-only payloads with durable conversation objects.

Acceptance criteria:
- Conversation objects are persisted, replayable, and renderable in UI threads.
