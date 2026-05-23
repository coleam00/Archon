# Task-Management Community Adapters

Adapters in this category connect Archon to project/ticket management platforms (e.g., Jira).

## Conventions

- **conversationId**: Issue key (e.g. `DF-123`, `PROJ-42`). Globally unique per Jira instance.
- **No codebase/repo management**: Unlike forge adapters, task-management adapters do not clone repos or manage codebases. Conversation semantics match the chat family.
- **Auth**: Shared secret delivered as URL query param `?secret=` (Jira's native webhook mechanism — no HMAC).
- **Message format**: Atlassian Document Format (ADF) for Jira Cloud REST API v3 comment bodies.
- **Trigger**: Comment containing an ADF mention node matching the bot's accountId.

## Adapters

| Adapter | Package subpath |
|---------|----------------|
| Jira Cloud | `@archon/adapters/community/task-management/jira` |
