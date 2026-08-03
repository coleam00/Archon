## Summary

Describe this PR in 2-5 bullets:

- Problem:
- Why it matters:
- What changed:
- What did **not** change (scope boundary):

## UX Journey

### Before

```
(Draw the user-facing flow BEFORE this PR. Show each step the user takes.)

Example:
  User                   Archon                   AI Client
  ────                   ──────                   ─────────
  sends message ──────▶  resolves session
                         loads context
                         streams to AI ──────────▶ processes prompt
                         receives chunks ◀──────── streams response
  sees reply ◀─────────  sends to platform
```

### After

```
(Draw the user-facing flow AFTER this PR. Highlight what changed with [brackets] or asterisks.)
```

## Architecture Diagram

### Before

```
(Map ALL modules touched or connected to this change. Draw lines between them.)
```

### After

```
(Same diagram with changes highlighted. Mark new modules with [+], removed with [-],
 modified with [~]. Mark new connections with ===, removed with --x--.)
```

**Connection inventory** (list every module-to-module edge, mark changes):

| From | To | Status | Notes |
|------|----|--------|-------|
| | | unchanged / **new** / **removed** / **modified** | |

## Label Snapshot

- Risk: `risk: low|medium|high`
- Size: `size: XS|S|M|L|XL`
- Scope: `core|workflows|isolation|git|adapters|server|web|cli|paths|config|docs|dependencies|ci|tests|skills`
- Module: `<scope>:<component>` (e.g. `workflows:executor`, `adapters:slack`, `core:orchestrator`)

## Change Metadata

- Change type: `bug|feature|refactor|docs|security|chore`
- Primary scope: `core|workflows|isolation|git|adapters|server|web|cli|paths|multi`

## Linked Issue

- Closes #
- Related #
- Depends on # (if stacked)
- Supersedes # (if replacing older PR)

## Validation Evidence (required)

Commands and result summary:

```bash
bun run type-check
bun run lint
bun run format:check
bun run test
# Or all at once:
bun run validate
```

- Evidence provided (test/log/trace/screenshot):
- If any command is intentionally skipped, explain why:

## Security Impact (required)

- New permissions/capabilities? (`Yes/No`)
- New external network calls? (`Yes/No`)
- Secrets/tokens handling changed? (`Yes/No`)
- File system access scope changed? (`Yes/No`)
- If any `Yes`, describe risk and mitigation:

## Compatibility / Migration

- Backward compatible? (`Yes/No`)
- Config/env changes? (`Yes/No`)
- Database migration needed? (`Yes/No`)
- If yes, exact upgrade steps:

## Human Verification (required)

What was personally validated beyond CI:

- Verified scenarios:
- Edge cases checked:
- What was not verified:

## Side Effects / Blast Radius (required)

- Affected subsystems/workflows:
- Potential unintended effects:
- Guardrails/monitoring for early detection:

## Rollback Plan (required)

- Fast rollback command/path:
- Feature flags or config toggles (if any):
- Observable failure symptoms:

## Risks and Mitigations

List real risks in this PR (or write `None`).

- Risk:
  - Mitigation:
