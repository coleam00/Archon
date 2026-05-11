---
name: Bug Report
about: Report a bug to help us improve
title: ''
labels: bug
assignees: ''
---

## Summary

- What broke:
- When it started (if known):
- Severity: `blocker|major|minor|cosmetic`

## Steps to Reproduce

1.
2.
3.

## Expected vs Actual

- **Expected**:
- **Actual**:

## User Flow

```
(Draw the flow that triggers the bug. Mark where it breaks with [X].)

Example:
  User                   Archon                   AI Client
  ────                   ──────                   ─────────
  sends /plan ─────────▶ routes to workflow
                         creates worktree
                         streams to AI ──────────▶ processes prompt
                         [X] timeout waiting ◀──── no response
  sees error ◀────────── sends error message
```

## Environment

- Platform: (Slack / Telegram / GitHub / Discord / Web / CLI)
- Database: (SQLite / PostgreSQL)
- Running in worktree? (`Yes/No`)
- OS:

## Logs

```
Paste relevant logs here (redact any tokens/secrets)
```

## Impact

- Affected workflows/commands:
- Reproduction rate: Always / Intermittent / Once
- Workaround available? If so, describe:
- Data loss risk? (`Yes/No`)

## Scope

- Package(s) likely involved: `core|workflows|isolation|git|adapters|server|web|cli|paths`
- Module (if known): e.g. `workflows:executor`, `adapters:slack`
