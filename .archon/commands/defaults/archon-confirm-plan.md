---
description: plan research가 여전히 유효한지 확인 — 패턴 존재 여부와 코드 drift 점검
argument-hint: (no arguments - reads from workflow artifacts)
---

# Plan Research 확인

**Workflow ID**: $WORKFLOW_ID

---

## 미션

Verify that the plan's research is still valid before implementation begins.

Plans can become stale:
- Files may have been renamed or moved
- Code patterns may have changed
- APIs may have been updated

**This step does NOT implement anything** - it only validates the plan is still accurate.

---

## 1단계: 로드 — context artifact 읽기

### 1.1 plan context 로드

```bash
cat $ARTIFACTS_DIR/plan-context.md
```

If not found, STOP with error:
```
❌ Plan context not found at $ARTIFACTS_DIR/plan-context.md

Run archon-plan-setup first.
```

### 1.2 검증 대상 추출

From the context, identify:

1. **Patterns to Mirror** - Files and line ranges to verify
2. **Files to Change** - Files that will be created/updated
3. **Validation Commands** - Commands that should work

**PHASE_1_CHECKPOINT:**

- [ ] Context artifact loaded
- [ ] Patterns to verify extracted
- [ ] Files to change identified

---

## 2단계: 확인 — 패턴 존재 확인

### 2.1 pattern file 확인

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

### 2.2 findings 문서화

For each pattern file:

| File | Status | Notes |
|------|--------|-------|
| `src/adapters/telegram.ts` | ✅ EXISTS | Lines 11-23 match expected pattern |
| `src/types/index.ts` | ✅ EXISTS | Interface still present |
| `src/old-file.ts` | ❌ MISSING | File was renamed/deleted |
| `src/changed.ts` | ⚠️ DRIFTED | Code structure changed significantly |

### 2.3 severity 평가

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

## 3단계: 확인 — 대상 위치 확인

### 3.1 생성할 파일 확인

For each file marked CREATE:

1. Verify it doesn't already exist (would be unexpected):
   ```bash
   test -f {file-path} && echo "ALREADY EXISTS" || echo "OK - will create"
   ```

2. Verify parent directory exists or can be created:
   ```bash
   dirname {file-path} | xargs test -d && echo "DIR EXISTS" || echo "DIR WILL BE CREATED"
   ```

### 3.2 수정할 파일 확인

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

## 4단계: 확인 — validation command 확인

### 4.1 validation command dry run

Test that the validation commands work (without expecting them to pass):

```bash
# Check type-check command exists
bun run type-check --help 2>/dev/null || echo "type-check not available"

# Check lint command exists
bun run lint --help 2>/dev/null || echo "lint not available"

# Check test command exists
bun test --help 2>/dev/null || echo "test not available"
```

### 4.2 command 사용 가능 여부 문서화

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

## 5단계: Artifact — confirmation 작성

### 5.1 confirmation artifact 작성

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

## 6단계: 출력 — 사용자에게 보고

### 확인됨(blocker 없음):

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

### Blocked인 경우:

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

## 성공 기준

- **PATTERNS_VERIFIED**: All pattern files exist and are reasonably similar
- **TARGETS_VALID**: CREATE files don't exist, UPDATE files do exist
- **COMMANDS_AVAILABLE**: Validation commands can be run
- **ARTIFACT_WRITTEN**: Confirmation artifact created with clear status
