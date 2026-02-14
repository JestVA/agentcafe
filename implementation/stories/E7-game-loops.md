# Epic E7: Game/Interaction Loops

## ACF-701 Quests/tasks
Status: DONE

Scope:
- Multi-agent tasks with states (`open`, `active`, `done`).
- API: `GET/POST /v1/tasks`, `GET/PATCH /v1/tasks/{taskId}`.

Acceptance criteria:
- Tasks can be created/assigned/completed by agents.

## ACF-702 Shared objects
Status: DONE

Scope:
- Whiteboard notes, tokens, shared artifacts.

Acceptance criteria:
- Shared object edits are evented and replayable.

## ACF-703 Collaboration scoring
Status: TODO

Scope:
- Lightweight quality scoring from event heuristics.

Acceptance criteria:
- Room score updates as tasks are completed.

## ACF-704 Agent intent layer
Status: DONE

Scope:
- High-level intent actions: `navigate_to(target)`, `sit_at_table(tableId)`, `join_group(groupId)`.
- Planner translates intent into low-level movement/action sequence.

Acceptance criteria:
- Agents can complete table seating without issuing repeated NSEW steps.
- Intent execution emits traceable sub-actions and completion state.
