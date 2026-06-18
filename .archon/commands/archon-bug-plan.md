---
description: Write a fix plan from investigation + optional human feedback
argument-hint: <jira-key>
---

# Produce Fix Plan

Your job is to write a clean, actionable fix plan to `$ARTIFACTS_DIR/plan.md`.

The caller is BugKiller's plan-approval workflow. The plan you produce will be
posted to JIRA and reviewed by a human before any implementation occurs.

## Step 1 — Read context

```bash
JIRA_KEY=$(cat "$ARTIFACTS_DIR/.jira-key")
echo "Ticket: $JIRA_KEY"

echo "=== INVESTIGATION ==="
cat "$ARTIFACTS_DIR/investigation.md"

# Revision flow: prior plan + human feedback may exist
if [ -f "$ARTIFACTS_DIR/prior-plan.md" ]; then
  echo "=== PRIOR PLAN (for revision) ==="
  cat "$ARTIFACTS_DIR/prior-plan.md"
fi
if [ -n "$BUGKILLER_PLAN_FEEDBACK" ]; then
  echo "=== HUMAN FEEDBACK (for revision) ==="
  echo "$BUGKILLER_PLAN_FEEDBACK"
fi
```

## Step 2 — Write `$ARTIFACTS_DIR/plan.md`

**Rules:**
- If `prior-plan.md` exists AND `$BUGKILLER_PLAN_FEEDBACK` is set, **REVISE** the prior plan
  to address the feedback. The output should read as a clean current-state document, not a diff.
- Otherwise, write a fresh plan derived from the investigation.
- Use this exact structure:

```markdown
# Fix Plan: <JIRA_KEY>

## Objective
<one sentence describing what the fix achieves>

## Affected Files
- `<repo-relative path>` — <why this file is touched>
- `<repo-relative path>` — <why this file is touched>

### New Files (only if any are required)
- `<repo-relative path>` — <purpose>

## Step-by-step Tasks
Numbered tasks in execution order. Each must be concrete enough that the IMPLEMENT
step can act on it without re-deriving intent.

### 1. <Task name>
- <specific action>
- <specific action>

### 2. <Task name>
- ...

## Acceptance Criteria
- <measurable criterion the fix must satisfy>
- <measurable criterion>

## Validation Commands
- `<command>` — <what it proves>

## Risks & Notes
<optional: edge cases, dependencies, behaviors deliberately not addressed>
```

If revision notes are useful for the next reviewer, append them at the bottom in an
HTML comment block: `<!-- revision-notes: addressed feedback X, kept original choice Y because Z -->`.
Do NOT include feedback discussion in the plan body itself — keep the plan readable
as a standalone current-state document.

## Step 3 — Verify

Confirm `$ARTIFACTS_DIR/plan.md` exists and is non-empty before exiting:

```bash
test -s "$ARTIFACTS_DIR/plan.md" && echo "Plan written ($(wc -l < "$ARTIFACTS_DIR/plan.md") lines)" \
  || { echo "FATAL: plan.md is missing or empty" >&2; exit 1; }
```
