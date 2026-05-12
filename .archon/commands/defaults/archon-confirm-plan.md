---
description: Verify plan research is still valid - check patterns exist, code hasn't drifted
argument-hint: (no arguments - reads from workflow artifacts)
---

# Confirm Plan Research

**Workflow ID**: $WORKFLOW_ID

---

## Your Mission

Verify that the plan's research is still valid before implementation begins.

Plans can become stale:
- Files may have been renamed or moved
- Code patterns may have changed
- APIs may have been updated

**This step does NOT implement anything** - it only validates the plan is still accurate.

---

## Phase 1: LOAD - Read Context Artifact

### 1.1 Load Plan Context

```bash
cat $ARTIFACTS_DIR/plan-context.md
```

If not found, STOP with error:
```
❌ Plan context not found at $ARTIFACTS_DIR/plan-context.md

Run archon-plan-setup first.
```

### 1.2 Extract Verification Targets

From the context, identify:

1. **Patterns to Mirror** - Files and line ranges to verify
2. **Files to Change** - Files that will be created/updated
3. **Validation Commands** - Commands that should work

**PHASE_1_CHECKPOINT:**

- [ ] Context artifact loaded
- [ ] Patterns to verify extracted
- [ ] Files to change identified

---

## Phase 2: VERIFY - Check Patterns Exist

### 2.1 Verify Pattern Files

For each file in "Patterns to Mirror":

1. Check if file exists:
   ```bash
   test -f {file-path} && echo "EXISTS" || echo "MISSING"
   ```

2. If exists, read the referenced lines:
   ```bash
   sed -n '{start},{end}p' {file-path}
   ```

3. Compare with what the plan expected (if plan included code snippets)

### 2.2 Document Findings

For each pattern file:

| File | Status | Notes |
|------|--------|-------|
| `src/adapters/telegram.ts` | ✅ EXISTS | Lines 11-23 match expected pattern |
| `src/types/index.ts` | ✅ EXISTS | Interface still present |
| `src/old-file.ts` | ❌ MISSING | File was renamed/deleted |
| `src/changed.ts` | ⚠️ DRIFTED | Code structure changed significantly |

### 2.3 Severity Assessment

| Finding | Severity | Action |
|---------|----------|--------|
| File exists, code matches | ✅ OK | Proceed |
| File exists, minor differences | ⚠️ WARNING | Note in artifact, proceed with caution |
| File exists, major drift | 🟠 CONCERN | Flag for review, may need plan update |
| File missing | ❌ BLOCKER | Stop, plan needs revision |

**PHASE_2_CHECKPOINT:**

- [ ] All pattern files checked
- [ ] Findings documented
- [ ] Severity assessed

---

## Phase 3: VERIFY - Check Target Locations

### 3.1 Check Files to Create

For each file marked CREATE:

1. Verify it doesn't already exist (would be unexpected):
   ```bash
   test -f {file-path} && echo "ALREADY EXISTS" || echo "OK - will create"
   ```

2. Verify parent directory exists or can be created:
   ```bash
   dirname {file-path} | xargs test -d && echo "DIR EXISTS" || echo "DIR WILL BE CREATED"
   ```

### 3.2 Check Files to Update

For each file marked UPDATE:

1. Verify it exists:
   ```bash
   test -f {file-path} && echo "EXISTS" || echo "MISSING"
   ```

2. If the plan references specific lines/functions, verify they exist

**PHASE_3_CHECKPOINT:**

- [ ] CREATE targets verified (don't exist yet)
- [ ] UPDATE targets verified (do exist)

---

## Phase 4: VERIFY - Check Validation Commands

### 4.1 Dry Run Validation Commands

Test that the validation commands work (without expecting them to pass):

```bash
# Check type-check command exists
bun run type-check --help 2>/dev/null || echo "type-check not available"

# Check lint command exists
bun run lint --help 2>/dev/null || echo "lint not available"

# Check test command exists
bun test --help 2>/dev/null || echo "test not available"
```

### 4.2 Document Command Availability

| Command | Status |
|---------|--------|
| `bun run type-check` | ✅ Available |
| `bun run lint` | ✅ Available |
| `bun test` | ✅ Available |
| `bun run build` | ✅ Available |

**PHASE_4_CHECKPOINT:**

- [ ] Validation commands tested
- [ ] All required commands available

---

## Phase 5: ARTIFACT - Write Confirmation

### 5.1 Write Confirmation Artifact

Write to `$ARTIFACTS_DIR/plan-confirmation.md`:

```markdown
# Plan Confirmation

**Generated**: {YYYY-MM-DD HH:MM}
**Workflow ID**: $WORKFLOW_ID
**Status**: {CONFIRMED | WARNINGS | BLOCKED}

---

## Pattern Verification

| Pattern | File | Status | Notes |
|---------|------|--------|-------|
| Constructor pattern | `src/adapters/telegram.ts:11-23` | ✅ | Matches expected |
| Interface definition | `src/types/index.ts:49-74` | ✅ | Present |
| ... | ... | ... | ... |

**Pattern Summary**: {X} of {Y} patterns verified

---

## Target Files

### Files to Create

| File | Status |
|------|--------|
| `src/new-file.ts` | ✅ Does not exist (ready to create) |

### Files to Update

| File | Status |
|------|--------|
| `src/existing.ts` | ✅ Exists |

---

## Validation Commands

| Command | Available |
|---------|-----------|
| `bun run type-check` | ✅ |
| `bun run lint` | ✅ |
| `bun test` | ✅ |
| `bun run build` | ✅ |

---

## Issues Found

{If no issues:}
No issues found. Plan research is valid.

{If issues:}
### Warnings

- **{file}**: {description of drift or concern}

### Blockers

- **{file}**: {description of missing file or critical issue}

---

## Recommendation

{One of:}
- ✅ **PROCEED**: Plan research is valid, continue to implementation
- ⚠️ **PROCEED WITH CAUTION**: Minor drift detected, implementation may need adjustments
- ❌ **STOP**: Critical issues found, plan needs revision

---

## Next Step

{If PROCEED or PROCEED WITH CAUTION:}
Continue to `archon-implement-tasks` to execute the plan.

{If STOP:}
Revise the plan to address blockers, then re-run `archon-plan-setup`.
```

**PHASE_5_CHECKPOINT:**

- [ ] Confirmation artifact written
- [ ] Status clearly indicated
- [ ] Issues documented

---

## Phase 6: OUTPUT - Report to User

### If Confirmed (no blockers):

```markdown
## Plan Confirmed ✅

**Workflow ID**: `$WORKFLOW_ID`
**Status**: Ready for implementation

### Verification Summary

| Check | Result |
|-------|--------|
| Pattern files | ✅ {X}/{Y} verified |
| Target files | ✅ Ready |
| Validation commands | ✅ Available |

{If warnings:}
### Warnings

- {warning 1}
- {warning 2}

These are minor and shouldn't block implementation.

### Artifact

Confirmation written to: `$ARTIFACTS_DIR/plan-confirmation.md`

### Next Step

Proceed to `archon-implement-tasks` to execute the plan.
```

### If Blocked:

```markdown
## Plan Blocked ❌

**Workflow ID**: `$WORKFLOW_ID`
**Status**: Cannot proceed

### Blockers Found

1. **{file}**: {description}
2. **{file}**: {description}

### Required Action

The plan references files or patterns that no longer exist. Options:

1. **Update the plan** to reflect current codebase state
2. **Restore missing files** if they were accidentally deleted
3. **Re-run planning** with `/archon-plan` to generate a fresh plan

### Artifact

Details written to: `$ARTIFACTS_DIR/plan-confirmation.md`
```

---

## Success Criteria

- **PATTERNS_VERIFIED**: All pattern files exist and are reasonably similar
- **TARGETS_VALID**: CREATE files don't exist, UPDATE files do exist
- **COMMANDS_AVAILABLE**: Validation commands can be run
- **ARTIFACT_WRITTEN**: Confirmation artifact created with clear status
