---
title: 핵심 개념
description: Archon의 핵심 개념 — workflow, node, command, isolation.
category: getting-started
audience: [user]
sidebar:
  order: 1
---

HarnessLab이 다루는 Archon fork의 동작 방식은 네 가지 핵심 개념으로 이해할 수 있습니다. 이 개념들을 먼저 잡아두면 나머지 문서와 워크플로 구조가 훨씬 자연스럽게 연결됩니다.

## Workflows

**workflow**는 여러 단계로 이루어진 AI 코딩 작업을 directed acyclic graph(DAG)로 정의하는 YAML 파일입니다. 각 workflow는 `.archon/workflows/`에 위치하며, 이름, 설명, 그리고 의존성이 선언된 node 집합을 가집니다.

```yaml
name: fix-issue
description: Investigate and fix a GitHub issue

nodes:
  - id: investigate
    command: investigate-issue

  - id: implement
    command: implement-issue
    depends_on: [investigate]
    context: fresh
```

의존성이 없는 node는 즉시 실행됩니다. 같은 의존성 계층에 있는 node들은 병렬로 실행됩니다. 즉, 독립적인 review node가 세 개 있는 workflow라면 세 node가 동시에 fan out되어 실행되고, 이후 세 node 모두에 의존하는 downstream node에서 다시 합류합니다.

Archon에는 기본 workflow가 함께 제공됩니다. 사용할 수 있는 항목은 `archon workflow list`로 확인하거나, 실제 예시는 `.archon/workflows/defaults/`에서 살펴볼 수 있습니다.

## Nodes

node는 workflow를 구성하는 기본 단위입니다. 각 node는 정확히 하나의 일을 하며, 모든 node는 아래 여섯 가지 타입 중 정확히 하나를 지정해야 합니다.

| 타입 | 역할 |
|------|-------------|
| `command:` | `.archon/commands/`에서 command 파일을 불러와 AI 에이전트에 보냅니다 |
| `prompt:` | inline prompt 문자열을 AI 에이전트에 보냅니다 |
| `bash:` | shell script를 실행합니다(AI 없음). stdout은 `$nodeId.output`으로 캡처됩니다 |
| `loop:` | 완료 신호가 감지될 때까지 AI prompt를 반복 실행합니다 |
| `approval:` | 사람이 검토할 수 있도록 workflow를 일시정지합니다(approve 또는 reject) |
| `cancel:` | 이유 문자열과 함께 workflow를 조기 종료합니다 |

node들은 `depends_on`으로 연결되어 DAG를 이룹니다. `when:` 표현식으로 조건 분기를 추가하고, `trigger_rule`로 join 동작을 제어하며, node별로 AI provider나 model을 override할 수 있습니다.

```yaml
nodes:
  - id: classify
    command: classify-issue
    output_format:
      type: object
      properties:
        type: { type: string, enum: [BUG, FEATURE] }
      required: [type]

  - id: fix-bug
    command: fix-bug
    depends_on: [classify]
    when: "$classify.output.type == 'BUG'"

  - id: build-feature
    command: build-feature
    depends_on: [classify]
    when: "$classify.output.type == 'FEATURE'"
```

## Commands

**command**는 AI prompt template 역할을 하는 `.archon/commands/` 안의 markdown 파일입니다. workflow node가 `command: investigate-issue`를 참조하면, Archon은 `.archon/commands/investigate-issue.md`를 불러오고 변수를 치환한 뒤 결과를 AI에 보냅니다.

command는 variable substitution을 지원합니다. 가장 자주 쓰는 변수는 다음과 같습니다.

| 변수 | 치환 대상 |
|----------|-------------|
| `$ARGUMENTS` | 사용자의 입력 메시지 |
| `$ARTIFACTS_DIR` | workflow artifact를 위해 미리 생성된 디렉터리 |
| `$BASE_BRANCH` | base branch(자동 감지 또는 설정값) |
| `$DOCS_DIR` | 문서 디렉터리 경로(기본값: `docs/`) |
| `$WORKFLOW_ID` | 현재 workflow run의 고유 ID |

전체 목록은 [Variable Reference](/reference/variables/)를 참고하세요.

Archon에는 investigation, implementation, code review 같은 일반적인 작업을 위한 기본 command가 함께 제공됩니다. `.archon/commands/`에 있는 repo-level command는 같은 이름의 bundled default를 override합니다.

## Isolation (Worktrees)

모든 workflow run은 기본적으로 자기만의 **git worktree**를 받습니다. 이는 저장소의 격리된 복사본입니다. 이 방식은 세 가지 이점을 제공합니다.

1. **작업 중인 branch가 깨끗하게 유지됩니다.** workflow 변경은 별도 디렉터리에서 일어납니다.
2. **여러 workflow가 서로 충돌하지 않고 병렬로 실행됩니다.**
3. **실패한 run이 작업 공간을 어지럽히지 않습니다.** `archon isolation cleanup`으로 정리할 수 있습니다.

worktree는 `~/.archon/workspaces/<owner>/<repo>/worktrees/`에 생성됩니다. 각 worktree는 자기 branch를 가지므로, 결과를 확인하고 PR을 만들거나 버릴 수 있습니다.

isolation을 끄고 현재 checkout에서 직접 실행하려면 `--no-worktree`를 전달합니다.

```bash
archon workflow run quick-fix --no-worktree "Fix the typo in README"
```

worktree branch 작업이 끝나면 다음 명령으로 worktree와 local/remote branch를 함께 정리할 수 있습니다.

```bash
archon complete <branch-name>
```

---

## 다음 단계

- [빠른 시작](/getting-started/quick-start/) -- 첫 workflow 실행하기
- [Workflow 작성](/guides/authoring-workflows/) -- 나만의 multi-step workflow 만들기
- [Command 작성](/guides/authoring-commands/) -- 효과적인 prompt template 작성하기
- [변수 레퍼런스](/reference/variables/) -- 지원되는 모든 변수
