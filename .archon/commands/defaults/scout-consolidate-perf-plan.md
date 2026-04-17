---
description: Merge per-route Scout profiles into a single implementation plan (plan.md)
argument-hint: (no arguments)
---

# Consolidate Scout performance plan

**Workflow ID**: $WORKFLOW_ID  
**Artifacts**: $ARTIFACTS_DIR

---

## Mission

Read:

- `$ARTIFACTS_DIR/routes.json`
- `$ARTIFACTS_DIR/routes-summary.md`
- `$ARTIFACTS_DIR/profile-00.md` … `$ARTIFACTS_DIR/profile-09.md` (include only files that exist; skipped indices may say SKIPPED)

Produce **one** implementation plan at **`$ARTIFACTS_DIR/plan.md`** that `archon-plan-setup` / `archon-confirm-plan` / `archon-implement-tasks` can consume.

---

## Plan template (required sections)

Use this structure (fill with real content from profiles):

```markdown
# Performance: Scout hot-route optimizations

## Summary
{1–2 sentences}

## Mission
{Single goal statement}

## NOT Building (Scope Limits)
- {Explicit non-goals — e.g. unrelated refactors, new features}
- Do not change behavior except latency/resource usage unless noted.

## Success Criteria
- [ ] Each targeted route has measurable improvement or documented tradeoff
- [ ] Project validation suite passes (see CLAUDE.md)
- [ ] Scout shows no new regressions for these endpoints after deploy (verification note)

## Files to Change

| File | Action |
|------|--------|
| `{path}` | UPDATE |

## Patterns to Mirror

| Pattern | Source File | Lines |
|---------|-------------|-------|
| {name} | `{path}` | {lines} |

## Task List

### Task 1: {title}
**Action**: UPDATE  
**Details**: {specific changes}  
**Route**: `{METHOD} {path}`  
**Validate**: {command}

### Task 2: ...

(Add one or more tasks per route or grouped fix.)

## Validation Commands
1. Commands from CLAUDE.md / package.json (typecheck, lint, test).

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| {risk} | {H/M/L} | {mitigation} |
```

---

## Rules

1. **Deduplicate** overlapping tasks if multiple profiles touch the same file.  
2. **Order** tasks by dependency (models before handlers, shared utils first).  
3. **Reference** actual symbols/files from the profile markdown files.  
4. If profiles disagree, prefer the most evidence-backed recommendation and note the conflict in **Risks**.  
5. Ignore profiles that are SKIPPED or empty.

---

## Output

- Write **`$ARTIFACTS_DIR/plan.md`** only (plan-setup will create `plan-context.md`).  
- Stdout: `Plan written to $ARTIFACTS_DIR/plan.md with {N} tasks.`
