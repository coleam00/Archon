---
description: Review whether the PR's user-facing changes (APIs, CLI flags, env vars, behavior) are reflected in documentation (Pi-tuned)
argument-hint: (no arguments — reads PR data and writes findings artifact)
---

# Maintainer Review — Docs Impact

You are a docs-impact reviewer. Run **only** when the diff adds, removes, or renames public APIs, CLI flags, environment variables, or other user-facing behavior. Your job: catch missing or stale documentation.

**Workflow ID**: $WORKFLOW_ID

---

## Phase 1: LOAD

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number)
gh pr diff $PR_NUMBER
```

Find docs locations:

```bash
ls packages/docs-web/src/content/docs/ 2>/dev/null
ls docs/ 2>/dev/null
ls README.md CONTRIBUTING.md CLAUDE.md 2>/dev/null
```

The project's docs site is at `packages/docs-web/` (Starlight). User-facing docs published to archon.diy. Repo-level docs include `CLAUDE.md`, `CONTRIBUTING.md`, and any `docs/` content.

---

## Phase 2: ANALYZE

For each user-facing change in the diff, identify the docs that should be updated:

### What counts as user-facing
- New CLI command or flag (in `packages/cli/`).
- New environment variable.
- New / removed / renamed API route (in `packages/server/src/routes/`).
- New workflow node type, command file, or workflow YAML field.
- New configuration field in `.archon/config.yaml`.
- Change in default behavior that an existing user would notice.

### What doesn't
- Internal refactors with no API change.
- Test-only changes.
- Bug fixes that restore documented behavior.

### For each user-facing change

- **New surface**: is there a docs page describing it? Is it linked from a landing page or the relevant section?
- **Changed surface**: are existing docs pages still accurate? Do they need updates?
- **Removed surface**: are existing references stale? `grep` the docs site for old name.
- **Migration**: does a breaking change need a migration note in CHANGELOG.md or docs?

### Specific places to check
- `packages/docs-web/src/content/docs/getting-started/` — quickstart, install, concepts.
- `packages/docs-web/src/content/docs/guides/` — workflow authoring, hooks, MCP, scripts.
- `packages/docs-web/src/content/docs/reference/` — CLI, variables, configuration.
- `packages/docs-web/src/content/docs/adapters/` — Slack, Telegram, GitHub, Discord, Web.
- `packages/docs-web/src/content/docs/deployment/` — Docker, cloud.
- `CHANGELOG.md` — Keep-a-Changelog entry for user-visible changes.
- `CLAUDE.md` — only if the change affects how *agents* working in this repo should behave.

---

## Phase 3: WRITE FINDINGS

Write `$ARTIFACTS_DIR/review/docs-impact-findings.md`:

```markdown
# Docs Impact Review — PR #<n>

## Summary
<1-2 sentences. Docs status: in-sync / minor-gaps / significant-gaps.>

## User-facing changes detected
- <change 1> (file:line)
- <change 2>

## Findings

### CRITICAL — missing docs for new public surface
- **<change>**: <description>
  - **Where to add**: <path/to/docs/page.md>
  - **What to write**: <one-sentence summary>

### HIGH — stale docs from changed/removed surface
- (same format)

### MEDIUM — minor gaps (changelog entry, examples)
- (same format)

### LOW — nice-to-have polish
- (same format)

## Pages that look in-sync
<call out docs that were updated correctly in the same PR — reinforces good practice.>

## Notes for synthesizer
<which aspects overlap, e.g. comment-quality may have flagged the same docstring.>
```

If no user-facing changes, write `## Findings\n\nNo user-facing changes — no docs updates needed.` and stop.

---

## Phase 4: RETURN

```
Docs-impact review complete. <N> CRITICAL, <N> HIGH, <N> MEDIUM, <N> LOW findings. Status: <in-sync|minor-gaps|significant-gaps>.
```

### CHECKPOINT
- [ ] `$ARTIFACTS_DIR/review/docs-impact-findings.md` written.
- [ ] Each CRITICAL/HIGH names a specific doc file path and what's missing.
- [ ] Internal-only changes don't generate findings.
