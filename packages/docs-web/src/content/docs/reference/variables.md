---
title: 변수 레퍼런스
description: Archon 명령과 workflow에서 사용할 수 있는 모든 변수 치환에 대한 전체 레퍼런스입니다.
category: reference
area: workflows
audience: [user]
sidebar:
  order: 5
---

Archon은 command file, inline prompt, bash script를 실행하기 전에 변수를 치환합니다. 변수에는 세 가지 범주가 있습니다: workflow variable(workflow engine이 치환), positional argument(command handler가 치환), node output reference(DAG workflow 전용).

## Workflow 변수

이 변수들은 모든 node type(`command:`, `prompt:`, `bash:`, `loop:`)에서 workflow executor가 치환합니다.

| Variable | 해석되는 값 | 참고 |
|----------|-------------|-------|
| `$ARGUMENTS` | workflow를 트리거한 사용자의 입력 메시지 | 사용자 입력을 command에 전달하는 기본 방법 |
| `$USER_MESSAGE` | `$ARGUMENTS`와 동일 | Alias |
| `$WORKFLOW_ID` | 현재 workflow run의 unique ID | artifact naming과 log correlation에 유용 |
| `$ARTIFACTS_DIR` | 미리 생성된 외부 artifact directory(`~/.archon/workspaces/<owner>/<repo>/artifacts/runs/<id>/`) | node 실행 전에 항상 존재하며, working tree 오염을 피하기 위해 repo 밖에 저장 |
| `$BASE_BRANCH` | git 작업의 base branch | repository default branch에서 auto-detect하거나 `.archon/config.yaml`의 `worktree.baseBranch`로 설정합니다. prompt에서 참조했지만 해석할 수 없으면 오류 발생 |
| `$DOCS_DIR` | documentation directory path | `.archon/config.yaml`의 `docs.path`로 설정합니다. 설정이 없으면 `docs/`가 기본값입니다. 절대 throw하지 않습니다 |
| `$CONTEXT` | 가능한 경우 GitHub issue 또는 PR context | GitHub issue/PR에서 workflow가 트리거될 때 채워집니다. 사용할 수 없으면 빈 문자열로 대체 |
| `$EXTERNAL_CONTEXT` | `$CONTEXT`와 동일 | Alias |
| `$ISSUE_CONTEXT` | `$CONTEXT`와 동일 | Alias |
| `$LOOP_USER_INPUT` | interactive loop approval gate에서 받은 user feedback | resumed interactive loop의 첫 iteration에서만 채워집니다. 그 외 iteration에서는 빈 문자열 |
| `$REJECTION_REASON` | approval node rejection에서 받은 reviewer feedback | `on_reject` prompt에서만 사용할 수 있습니다. 그 외에는 빈 문자열 |

### Context 변수 동작

세 context alias(`$CONTEXT`, `$EXTERNAL_CONTEXT`, `$ISSUE_CONTEXT`)는 모두 같은 값으로 해석됩니다. issue context가 없으면 AI에 literal `$CONTEXT` 텍스트를 보내지 않도록 빈 문자열로 바뀝니다.

issue context가 있지만 prompt에 context variable이 없으면 context가 prompt 끝에 자동으로 **추가**됩니다. command가 명시적으로 `$CONTEXT`를 사용할 때 context가 중복되는 것을 막기 위한 동작입니다.

### `$BASE_BRANCH` Fail-Fast

다른 변수와 달리 `$BASE_BRANCH`는 다음 조건이 모두 참이면 workflow를 **즉시 실패**시킵니다.
- prompt에서 이 변수를 참조했고,
- git에서 auto-detection이 실패했고,
- `.archon/config.yaml`에 `worktree.baseBranch`가 설정되어 있지 않음

변수를 참조하지 않으면 base branch를 확인할 수 없어도 오류가 발생하지 않습니다.

## Positional Argument

이 변수들은 command가 workflow 밖에서 직접 호출될 때 command handler가 치환합니다. workflow variable보다 먼저 처리됩니다.

| Variable | 해석되는 값 | 참고 |
|----------|-------------|-------|
| `$1` | 첫 번째 positional argument | 사용자 입력을 whitespace 기준으로 분리 |
| `$2` | 두 번째 positional argument | |
| `$3` ... `$9` | 세 번째부터 아홉 번째 positional argument | |
| `$ARGUMENTS` | 모든 argument를 하나의 문자열로 합친 값 | 같은 변수이며 두 context 모두에서 사용 가능 |
| `\$` | literal `$` character | 치환을 막으려면 dollar sign을 escape |

## Node Output Reference

DAG workflow에서 node는 완료된 upstream node의 output을 참조할 수 있습니다. 이는 workflow variable 이후에 치환됩니다.

| Pattern | 해석되는 값 | 참고 |
|---------|-------------|-------|
| `$nodeId.output` | 참조한 node의 전체 output string | 해당 node는 `depends_on`에 선언된 dependency여야 합니다 |
| `$nodeId.output.field` | node output의 특정 JSON field | upstream node가 structured JSON용 `output_format`을 사용해야 합니다 |

### 예시

```yaml
nodes:
  - id: classify
    command: classify-issue
    output_format:
      type: object
      properties:
        type: { type: string, enum: [BUG, FEATURE] }
      required: [type]

  - id: fix
    prompt: |
      The issue was classified as: $classify.output.type
      Full classification: $classify.output
      User's original request: $USER_MESSAGE
    depends_on: [classify]
```

## 치환 순서

변수는 정해진 순서로 치환됩니다.

1. **Workflow variables** -- `$WORKFLOW_ID`, `$USER_MESSAGE`, `$ARGUMENTS`, `$ARTIFACTS_DIR`, `$BASE_BRANCH`, `$DOCS_DIR`, `$LOOP_USER_INPUT`, `$REJECTION_REASON`
2. **Context variables** -- `$CONTEXT`, `$EXTERNAL_CONTEXT`, `$ISSUE_CONTEXT`
3. **Node output references** -- `$nodeId.output`, `$nodeId.output.field`

Positional argument(`$1`부터 `$9`)는 command handler가 별도로 치환하며, command를 직접 호출할 때만 사용할 수 있습니다. workflow node를 통해서는 사용할 수 없습니다.

## Context별 변수 사용 가능 여부

| Variable | Workflow node | 직접 command 호출 | `when:` condition |
|----------|---------------|--------------------------|-------------------|
| `$ARGUMENTS` / `$USER_MESSAGE` | 예 | 예(`$ARGUMENTS`) | 아니요 |
| `$1` ... `$9` | 아니요 | 예 | 아니요 |
| `$WORKFLOW_ID` | 예 | 아니요 | 아니요 |
| `$ARTIFACTS_DIR` | 예 | 아니요 | 아니요 |
| `$BASE_BRANCH` | 예 | 아니요 | 아니요 |
| `$DOCS_DIR` | 예 | 아니요 | 아니요 |
| `$CONTEXT` / aliases | 예 | 아니요 | 아니요 |
| `$LOOP_USER_INPUT` | 예(loop node) | 아니요 | 아니요 |
| `$REJECTION_REASON` | 예(`on_reject` only) | 아니요 | 아니요 |
| `$nodeId.output` | 예(DAG node) | 아니요 | 예 |
