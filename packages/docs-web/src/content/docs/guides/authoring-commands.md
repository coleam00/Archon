---
title: 명령 작성
description: AI workflow node의 구성 요소가 되는 prompt template을 작성합니다.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 2
---

이 가이드는 HarneesLab의 AI workflow system에서 효과적인 command를 작성하는 방법을 설명합니다. HarneesLab은 Archon fork로서 반복 가능한 agent workflow를 학습하고 실험하기 쉽게 다루며, command는 그 workflow의 구성 요소입니다. 각 command는 AI agent에게 무엇을 해야 하는지 지시하는 prompt template입니다.

## Command란 무엇인가요?

command는 AI agent를 위한 상세 instruction set 역할을 하는 **markdown file**입니다. workflow가 `- command: investigate-issue` 같은 step을 실행하면 HarneesLab은 다음을 수행합니다.

1. `.archon/commands/investigate-issue.md`에서 command file을 로드합니다
2. `$ARGUMENTS` 같은 변수를 실제 값으로 치환합니다
3. 전체 문서를 AI에 prompt로 보냅니다
4. AI가 instructions를 따르고 output을 생성합니다

**Command는 code가 아니라 prompt입니다.** 명확한 instructions로 AI behavior를 안내합니다.

---

## 파일 형식

command는 working directory 기준 `.archon/commands/`에 있으며 runtime에 로드됩니다. `.archon` 디렉터리 이름은 upstream Archon과의 호환성을 위해 유지됩니다.

> **CLI vs Server:** CLI는 실행한 위치에서 command를 읽습니다(uncommitted changes도 보임). server는 `~/.archon/workspaces/owner/repo/`에서 읽으며, 이 경로는 worktree creation 전에 remote에서만 sync됩니다. 따라서 server가 변경을 인식하려면 commit과 push가 필요합니다.

command는 다음 구조를 사용합니다.

```markdown
---
description: One-line description shown in /commands list
argument-hint: <expected-input-format>
---

# Command Name

**Input**: $ARGUMENTS

---

[Instructions for the AI agent...]
```

### Frontmatter Fields

| Field | Required | Purpose |
|-------|----------|---------|
| `description` | Recommended | `/commands` list와 workflow routing에 표시됩니다 |
| `argument-hint` | Optional | 사용자가 어떤 input을 제공해야 하는지 알려줍니다 |

---

## 황금률: Artifacts가 전부입니다

> **생성한 artifact가 다음 step의 specification입니다.**

multi-step workflow에서 agents는 memory를 공유하지 않습니다. step 사이에 정보를 전달하는 **유일한** 방법은 disk에 저장된 file인 **artifacts**입니다.

```
Step 1: investigate-issue    Step 2: implement-issue
┌─────────────────────┐      ┌─────────────────────┐
│ AI Agent A          │      │ AI Agent B          │
│                     │      │                     │
│ Analyzes issue      │      │ Reads artifact      │
│ Produces artifact ──┼──────┼─> Executes plan     │
│                     │      │                     │
└─────────────────────┘      └─────────────────────┘
        │                            │
        ▼                            │
  $ARTIFACTS_DIR/                    │
  issues/issue-123.md ◄──────────────┘
```

### 이것이 중요한 이유

- **shared context 없음**: 각 workflow node는 `context: fresh`로 실행될 수 있습니다
- **Resumability**: step이 실패해도 artifact가 진행 상황을 보존합니다
- **Auditability**: artifacts는 AI decision의 paper trail을 만듭니다
- **Handoff quality**: artifact가 다음 step의 성공 여부를 결정합니다

### 좋은 Artifact의 조건

artifact에는 **다음 agent가 필요한 모든 것**이 들어 있어야 합니다.

| Include | Why |
|---------|-----|
| Problem statement | 다음 agent에게 context가 필요합니다 |
| Specific file paths + line numbers | 어디를 봐야 할지 추측하지 않게 합니다 |
| Actual code snippets | summary가 아니라 실제 code가 필요합니다 |
| Step-by-step implementation plan | 질문 없이 실행 가능해야 합니다 |
| Validation commands | 성공 여부를 검증하는 방법입니다 |
| Edge cases and risks | 주의해야 할 항목입니다 |

**나쁜 artifact**: "Fix the authentication bug in the login handler"

**좋은 artifact**:
````markdown
## Problem
Users get 401 errors when token refresh races with API calls.

## Root Cause
`src/auth/refresh.ts:45` - The refresh lock doesn't wait for in-flight requests.

## Implementation Plan

### Step 1: Add request queue
**File**: `src/auth/refresh.ts`
**Lines**: 45-60

**Current code:**
```typescript
async function refresh() {
  // Current problematic code
}
```

**Change to:**
```typescript
async function refresh() {
  // Fixed code with queue
}
```

### Step 2: Add test
**File**: `src/auth/refresh.test.ts`
**Action**: CREATE

```typescript
describe('refresh', () => {
  it('queues requests during refresh', async () => {
    // Test implementation
  });
});
```

## Validation
```bash
bun run type-check
bun test src/auth/
```
````

---

## Command 구조

### Phase 기반 구성

command를 명확한 phase로 나누세요. 이렇게 하면 AI가 다음을 할 수 있습니다.
- process의 어느 지점에 있는지 파악
- 진행 전에 self-verify
- 실패 시 복구

```markdown
## Phase 1: LOAD - Get Context

### 1.1 First action
[Instructions...]

### 1.2 Second action
[Instructions...]

**PHASE_1_CHECKPOINT:**
- [ ] Data loaded
- [ ] Context understood
- [ ] Ready to proceed

---

## Phase 2: ANALYZE - Process Information

[...]
```

### phase가 효과적인 이유

1. **Chunked reasoning**: AI는 복잡한 작업을 조각으로 나눴을 때 더 잘 처리합니다
2. **Self-verification**: checkpoint가 AI에게 progress 검증을 강제합니다
3. **Debugging**: 실패 시 어느 phase에서 실패했는지 알 수 있습니다
4. **Consistency**: command 간 구조가 비슷하면 behavior를 예측하기 쉽습니다

### 흔한 Phase Patterns

| Phase Name | Purpose | Example Actions |
|------------|---------|-----------------|
| LOAD | input과 context 수집 | file 읽기, GitHub에서 fetch, arguments parse |
| EXPLORE | codebase 이해 | pattern 검색, code flow 추적 |
| ANALYZE | 결론 도출 | root cause analysis, design decisions |
| GENERATE | output 생성 | artifact 작성, file 생성 |
| VALIDATE | correctness 검증 | test 실행, type 확인, output review |
| COMMIT | git에 저장 | stage, commit, push |
| REPORT | 결과 전달 | user에게 summary output |

---

## Checkpoints

각 phase를 checkpoint로 끝내세요.

```markdown
**PHASE_2_CHECKPOINT:**
- [ ] Root cause identified with evidence
- [ ] All affected files listed
- [ ] Implementation approach determined
```

### checkpoint가 중요한 이유

- **Self-regulation**: AI가 모든 step을 완료했는지 검증합니다
- **Quality gate**: 다음 phase로 성급히 넘어가는 것을 막습니다
- **Debugging aid**: process가 어디서 깨졌는지 보여줍니다
- **Documentation**: 무엇이 완료됐는지 기록합니다

---

## Variable Substitution

HarneesLab은 command text를 AI에 보내기 전에 변수를 치환합니다. command에서 가장 자주 쓰는 변수는 다음과 같습니다.

| Variable | Value |
|----------|-------|
| `$ARGUMENTS` / `$USER_MESSAGE` | user의 input message |
| `$1`, `$2`, `$3` | positional arguments(direct invocation only) |
| `$ARTIFACTS_DIR` | 이 workflow run을 위해 미리 생성된 artifacts directory |
| `$BASE_BRANCH` | base branch(auto-detected 또는 configured) |
| `$DOCS_DIR` | documentation directory path(기본값: `docs/`) |
| `$WORKFLOW_ID` | unique workflow run ID |
| `$CONTEXT` | GitHub issue/PR context(사용 가능한 경우) |

`$LOOP_USER_INPUT`, `$REJECTION_REASON`, node output references, substitution order, context variable behavior를 포함한 전체 목록은 [Variable Reference](/reference/variables/)를 참고하세요.

### 사용 패턴

항상 input을 맨 위에 표시하세요.

```markdown
# Investigate Issue

**Input**: $ARGUMENTS

---

## Your Mission
[...]
```

이렇게 하면 AI가 무엇을 다루고 있는지 정확히 알 수 있습니다.

---

## Artifact Conventions

### Artifacts 위치

artifacts는 HarneesLab-managed workspace directory의 **repository 밖**에 저장됩니다. 기본 경로는 compatibility 때문에 `~/.archon`을 유지합니다. 각 workflow run을 위해 미리 생성된 artifacts directory를 참조하려면 `$ARTIFACTS_DIR` 변수를 사용하세요.

```
~/.archon/workspaces/owner/repo/artifacts/runs/{workflow-id}/
```

이렇게 하면 artifacts가 git에 들어가지 않고 working tree를 오염시키지 않습니다.

### Naming Conventions

| Artifact Type | Path Pattern |
|---------------|--------------|
| Issue investigation | `$ARTIFACTS_DIR/issues/issue-{number}.md` |
| Free-form investigation | `$ARTIFACTS_DIR/issues/investigation-{timestamp}.md` |
| PR review scope | `$ARTIFACTS_DIR/reviews/pr-{number}/scope.md` |
| Code review findings | `$ARTIFACTS_DIR/reviews/pr-{number}/code-review-findings.md` |

### AI에게 저장을 지시하기

artifact creation에 대해 명시적으로 지시하세요.

```markdown
## Phase 4: GENERATE - Create Artifact

### 4.1 Create Directory

```bash
mkdir -p $ARTIFACTS_DIR/issues
```

### 4.2 Write Artifact

Write to `$ARTIFACTS_DIR/issues/issue-{number}.md`:

```markdown
# Investigation: {Title}

**Issue**: #{number}
**Type**: {BUG|ENHANCEMENT}
...
```

**CRITICAL**: This artifact is the ONLY way to pass information to the next
workflow step. Include everything needed for implementation:

- Exact file paths with line numbers
- Actual code snippets (not summaries)
- Step-by-step implementation instructions
- Validation commands
- Edge cases to handle

The implementing agent will work ONLY from this artifact.
```

---

## 효과적인 Instructions 작성

### Tool 사용을 명확히 지시하기

AI에게 어떤 tool을 사용해야 하는지 알려주세요.

```markdown
### 2.1 Search for Relevant Code

Use Task tool with subagent_type="Explore":

```
Find all files related to authentication:
- Token handling
- Session management
- Login/logout flows
```

### 2.2 Check Git History

```bash
git log --oneline -10 -- {affected-file}
git blame -L {start},{end} {affected-file}
```
```

### Decision Tree 제공

AI가 다양한 scenario를 처리할 수 있게 도와주세요.

```markdown
### 3.2 Handle Git State

```
┌─ IN WORKTREE?
│  └─ YES → Use it (assume it's for this work)
│
├─ ON MAIN BRANCH?
│  └─ Clean? → Create branch: fix/issue-{number}
│  └─ Dirty? → STOP, ask user to commit/stash
│
└─ ON FEATURE BRANCH?
   └─ Use it (assume it's for this work)
```
```

### Error Handling 포함

문제가 생겼을 때 무엇을 해야 하는지 AI에게 알려주세요.

```markdown
## Handling Edge Cases

### Artifact not found
```
Artifact not found at $ARTIFACTS_DIR/issues/issue-{number}.md

Run `/investigate-issue {number}` first.
```

### Code has drifted
```
Code has changed since investigation:

File: src/x.ts:45
- Artifact expected: {snippet}
- Actual code: {different}

Options:
1. Re-run /investigate-issue
2. Proceed with manual adjustments
```
```

---

## Success Criteria

모든 command는 명확한 success criteria로 끝내세요.

```markdown
## Success Criteria

- **ARTIFACT_COMPLETE**: All sections filled with specific content
- **EVIDENCE_BASED**: Every claim has file:line reference
- **IMPLEMENTABLE**: Next agent can execute without questions
- **COMMITTED**: Artifact saved in git
```

이는 다음 역할을 합니다.
- AI를 위한 final checklist
- "done"의 정의
- command의 quality bar

---

## Template: Basic Command

```markdown
---
description: Brief description of what this command does
argument-hint: <expected-input>
---

# Command Name

**Input**: $ARGUMENTS

---

## Your Mission

{1-2 sentences explaining the goal and what success looks like}

**Output artifact**: `$ARTIFACTS_DIR/{category}/{name}.md`

---

## Phase 1: LOAD - Gather Context

### 1.1 Parse Input

{Instructions for understanding the input}

### 1.2 Load Dependencies

{Instructions for loading required context}

**PHASE_1_CHECKPOINT:**
- [ ] Input parsed correctly
- [ ] Required context loaded

---

## Phase 2: PROCESS - Do the Work

### 2.1 Main Action

{Core instructions}

### 2.2 Secondary Action

{Supporting instructions}

**PHASE_2_CHECKPOINT:**
- [ ] Main work completed
- [ ] Results validated

---

## Phase 3: GENERATE - Create Artifact

### 3.1 Artifact Location

```bash
mkdir -p $ARTIFACTS_DIR/{category}
```

**Path**: `$ARTIFACTS_DIR/{category}/{name}.md`

### 3.2 Artifact Content

Write this structure:

```markdown
# {Title}

**Created**: {timestamp}
**Input**: {original input}

## Summary

{Key findings/results}

## Details

{Comprehensive information for next step}

## Next Steps

{What the next agent should do with this}
```

**CRITICAL**: Include everything the next workflow step needs.

**PHASE_3_CHECKPOINT:**
- [ ] Artifact file created
- [ ] All sections populated
- [ ] Information is actionable

---

## Phase 4: COMMIT - Save Work

```bash
git add .
git commit -m "{Descriptive message}"
```

**PHASE_4_CHECKPOINT:**
- [ ] Changes committed

---

## Phase 5: REPORT - Output Results

```markdown
## Complete

**Artifact**: `$ARTIFACTS_DIR/{category}/{name}.md`

### Summary

{Brief results}

### Next Step

Run `/{next-command}` to continue.
```

---

## Success Criteria

- **CONTEXT_LOADED**: Required information gathered
- **WORK_COMPLETE**: Main task accomplished
- **ARTIFACT_SAVED**: Output written to correct location
- **COMMITTED**: Changes saved to git
```

---

## 피해야 할 Anti-Patterns

### 1. 모호한 Instructions

나쁜 예:
```markdown
Analyze the code and find the problem.
```

좋은 예:
```markdown
### 2.1 Trace the Error Path

1. Find where the error originates using grep:
   ```bash
   grep -r "ErrorType" src/
   ```

2. Read the file and identify the function:
   ```bash
   cat src/handlers/error.ts
   ```

3. Document the call chain leading to the error.
```

### 2. Artifact Instructions 누락

나쁜 예:
```markdown
## Results

Output your findings.
```

좋은 예:
```markdown
## Phase 4: GENERATE - Create Artifact

Write to `$ARTIFACTS_DIR/issues/issue-{number}.md`:

[Exact template with all required sections]

**CRITICAL**: This artifact is the handoff to the implementing agent.
```

### 3. Error Handling 없음

나쁜 예:
```markdown
Create the PR.
```

좋은 예:
```markdown
### Create PR

**First, check if PR already exists:**
```bash
gh pr list --head $(git branch --show-current)
```

**If PR exists**: Use existing PR, skip creation.

**If no PR**: Create new PR:
```bash
gh pr create --title "..." --body "..."
```
```

### 4. Context를 가정함

나쁜 예:
```markdown
Fix the bug in the file we discussed.
```

좋은 예:
```markdown
### 1.1 Load Artifact

```bash
cat $ARTIFACTS_DIR/issues/issue-{number}.md
```

Extract:
- File paths to modify
- Line numbers for changes
- Expected behavior
```

---

## Command 테스트

1. **수동 실행**: `hlab workflow run {workflow} "test input"`
2. **artifact output 확인**: 필요한 모든 내용이 들어 있나요?
3. **다음 step 시뮬레이션**: 다른 agent가 artifact만 보고 작업할 수 있나요?
4. **edge cases**: 잘못된 input이나 missing files에서는 어떻게 되나요?

---

## Summary

1. **Command는 prompt입니다** - AI agent를 위한 명확한 instructions를 작성하세요
2. **Artifacts는 handoff입니다** - step 사이에 data를 전달하는 유일한 방법입니다
3. **phase를 사용하세요** - 작업을 검증 가능한 chunk로 나누세요
4. **명시적으로 쓰세요** - AI에게 무엇을, 어디서, 어떻게 해야 하는지 정확히 알려주세요
5. **모든 것을 포함하세요** - 다음 agent는 오직 artifact만 보고 작업합니다
