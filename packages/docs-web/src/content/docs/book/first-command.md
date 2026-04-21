---
title: 첫 명령 만들기
description: AI가 단일 작업으로 실행하는 집중된 markdown prompt인 첫 HarneesLab command file을 작성합니다.
category: book
part: customization
audience: [user]
sidebar:
  order: 6
---

지금까지 command가 실제 일을 하는 모습을 봤습니다. issue를 조사하고, 코드를 작성하고, 리뷰를 게시했습니다. [3장](/book/how-it-works/)에서는 `archon-fix-github-issue`가 일곱 개 command를 어떻게 이어 붙이는지 추적했습니다. 이제 직접 하나를 작성해 봅니다.

command는 보기보다 단순합니다. plain markdown 파일입니다. AI는 이를 지시문으로 읽습니다.

---

## Command란 무엇인가?

**command**는 하나의 집중된 작업에서 AI가 정확히 무엇을 해야 하는지 알려 주는 markdown 파일입니다. Archon의 원자 단위이며, 독립적으로 실행되거나 workflow에 연결될 수 있는 가장 작은 단위입니다.

command는 repository의 `.archon/commands/`에 위치합니다. Archon이 `command: run-tests` 같은 단계를 실행하면 `.archon/commands/run-tests.md`를 찾고, 변수를 치환한 뒤 문서 전체를 AI에게 작업 지시로 보냅니다.

핵심은 이것입니다. command는 코드가 아니라 prompt입니다. AI가 하길 원하는 일을 작성하면 AI가 실행합니다.

> **어디에 두나**: 작업 중인 git repository에 `.archon/commands/` 디렉터리를 만드세요. Archon은 내장 기본 command와 함께 그곳의 command를 자동으로 찾습니다.

---

## Command의 구조

다음은 각 부분에 설명을 붙인 command file의 전체 구조입니다.

```markdown
---
description: Run tests for a specific module and report results    <- shown in /commands list
argument-hint: <module-name>                                        <- tells users what to pass
---

# Run Tests

**Input**: $ARGUMENTS                                              <- always show your input

---

## Your Task

Run the tests for the `$ARGUMENTS` module and report what you find.

[... AI instructions ...]
```

**frontmatter**(맨 위의 `---` block)는 선택 사항이지만 권장됩니다. `description` field는 누군가 `hlab workflow list`를 실행하거나 AI에게 사용 가능한 command를 물었을 때 표시됩니다. `argument-hint`는 사용자가 무엇을 넘겨야 하는지 알려 줍니다.

**body**는 AI에게 전달되는 실제 지시문입니다. 이 코드베이스를 처음 보는 유능한 엔지니어에게 작업을 설명하듯 작성하세요. 성공이 어떤 모습인지 구체적으로 적어야 합니다.

**변수**는 AI가 파일을 보기 전에 치환됩니다. `$ARGUMENTS`는 사용자가 command를 호출할 때 넘긴 값으로 바뀝니다.

---

## 만들어 보기: test runner command

실제 command를 만들어 봅시다. 목표는 특정 module의 테스트를 실행하고 결과를 명확하게 보고하는 것입니다.

### 1단계: 파일 만들기

```bash
mkdir -p .archon/commands
touch .archon/commands/run-tests.md
```

### 2단계: frontmatter 작성

```markdown
---
description: Run tests for a specific module and report results
argument-hint: <module-name>
---
```

### 3단계: 지시문 작성

```markdown
# Run Tests

**Module**: $ARGUMENTS

---

## Your Task

Run the test suite for the `$ARGUMENTS` module and produce a clear summary of the results.

## Steps

1. Find the test files for `$ARGUMENTS`:
   - Look in the same directory as the module source (e.g., `$ARGUMENTS.test.ts`)
   - Check any `__tests__/` or `tests/` subdirectories

2. Run the tests. Use the project's test runner (check `package.json` for the test script):
   ```bash
   bun test <path-to-test-files>
   ```

3. Report your findings with this structure:
   - **Status**: PASSED or FAILED
   - **Tests run**: total count
   - **Failures**: list each failing test with its error message
   - **Next step**: if tests failed, suggest the most likely fix

## If No Tests Found

If you can't find test files for `$ARGUMENTS`, say so clearly and list the files you searched.

## Success Criteria

- [ ] Tests located and run
- [ ] Results reported with pass/fail counts
- [ ] Failing tests identified with error messages
- [ ] Clear recommendation for next step
```

### 4단계: 테스트하기

`archon-assist`를 통해 command를 직접 호출할 수 있습니다.

```bash
hlab workflow run archon-assist "/command-invoke run-tests auth"
```

Archon은 `/command-invoke run-tests` 지시를 AI로 라우팅합니다. AI는 `.archon/commands/run-tests.md`를 찾고, `$ARGUMENTS`를 `auth`로 치환한 뒤 작업을 실행합니다.

AI가 auth module 테스트를 찾고 실행한 뒤 구조화된 보고서를 만드는 것을 볼 수 있어야 합니다.

---

## 변수 참조

| 변수 | 포함하는 값 | 예시 |
|----------|----------|---------|
| `$ARGUMENTS` | 사용자가 넘긴 전체 입력 | `"auth module"` |
| `$1` | 공백으로 나눈 첫 번째 argument | `auth` (`auth module`에서) |
| `$2` | 공백으로 나눈 두 번째 argument | `module` (`auth module`에서) |
| `$3` | 공백으로 나눈 세 번째 argument | — |
| `$ARTIFACTS_DIR` | 이 실행의 artifact directory 절대 경로 | `/home/user/.archon/workspaces/owner/repo/artifacts/runs/abc123/` |
| `$WORKFLOW_ID` | 현재 workflow run의 고유 ID | `abc123def456` |
| `$BASE_BRANCH` | 현재 worktree의 base branch | `main` |
| `$DOCS_DIR` | 문서 디렉터리 경로 | `docs/` |

나중 단계가 읽어야 할 output file을 command가 작성한다면 `$ARTIFACTS_DIR`를 사용하세요. argument를 하나의 문자열이 아니라 구조화된 positional input으로 다루고 싶다면 `$1`, `$2`, `$3`를 사용하세요.

---

## Command 설계 팁

**성공의 모습을 정의하세요.** command 마지막에 success criteria checklist를 두세요. AI에게 마지막 검증 단계를 제공하고, 여러분에게도 "완료"의 명확한 정의를 제공합니다.

**문제가 생겼을 때 무엇을 해야 하는지 AI에게 알려 주세요.** test file이 없으면 어떻게 해야 하나요? dependency가 없으면 어떻게 해야 하나요? edge case를 명시적으로 다루는 command는 AI가 즉흥적으로 판단하게 두는 command보다 훨씬 일관된 동작을 만듭니다.

**다음 단계가 필요한 정보는 artifact로 쓰세요.** command가 downstream step에서 사용할 정보를 만들면 AI가 이를 `$ARTIFACTS_DIR`에 파일로 쓰게 하세요. context가 초기화되는 단계 사이에서 AI가 기억해 주길 기대하지 마세요.

**command 하나에는 작업 하나만 담으세요.** 조사, 구현, PR 생성을 한 번에 하는 command를 만들고 싶은 유혹을 피하세요. 초점이 분명한 command는 재사용 가능하고, 디버깅 가능하고, 조합 가능합니다. 서로 다른 phase에 속하는 작업은 나누세요.

---

## Command 호출하기

**`archon-assist`에서** (interactive):
```bash
hlab workflow run archon-assist "/command-invoke run-tests auth"
```

**workflow에서** (automated):
```yaml
nodes:
  - id: validate
    command: run-tests
    prompt: "Run tests for the auth module"
```

**사용 가능한 항목 보기**:
```bash
hlab workflow run archon-assist "/commands"
```

이 명령은 사용 가능한 모든 command를 나열합니다. `.archon/commands/`의 custom command와 Archon의 내장 기본 command가 함께 표시됩니다. `archon-investigate-issue`, `archon-fix-issue` 같은 내장 command는 직접 command 구조를 정할 때 좋은 참고 자료입니다.

---

[7장: 첫 워크플로 만들기 →](/book/first-workflow/)에서는 방금 만든 command를 다단계 workflow에 연결합니다. 다른 단계와 조합하고, 단계 사이에 artifact를 전달하며, 처음부터 끝까지 자동으로 실행되는 것을 만들어 봅니다.
