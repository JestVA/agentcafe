# AgentCafe Implementation Workspace

This folder is the execution plan for turning AgentCafe from MVP into production architecture.

## What is here
- `00-roadmap.md`: phased delivery plan.
- `01-architecture.md`: target service architecture and contracts.
- `03-seamless-coordination-spec.md`: gap-closure spec for inbox/orchestrator/runtime UI.
- `02-backlog.md`: prioritized backlog with story IDs.
- `stories/`: detailed story sheets by epic.
- `progress/STORY_STATUS.md`: single status tracker to mark done/in-progress.
- `progress/RUN_LOG.md`: append one entry every implementation run.
- `progress/NEXT_RUN.md`: active priorities for the next run.

## How to track progress each run
1. Implement stories.
2. Update `progress/STORY_STATUS.md` (`TODO` -> `IN_PROGRESS` -> `DONE`).
3. Append evidence in `progress/RUN_LOG.md` with file paths and deployment/test notes.
4. Refresh `progress/NEXT_RUN.md` with top 3-5 next stories.

## Story ID convention
- `ACF-xxx`
- `001-099`: platform/foundation
- `100-199`: identity/presence
- `200-299`: conversation UX
- `300-399`: memory/context
- `400-499`: events/automation
- `500-599`: API ergonomics
- `600-699`: replay/debug
- `700-799`: game loops
- `800-899`: safety/operator
- `900-999`: migration/cutover
