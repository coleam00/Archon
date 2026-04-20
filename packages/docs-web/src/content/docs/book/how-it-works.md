---
title: Archon은 실제로 어떻게 동작하나
description: Archon이 다단계 workflow를 실행할 때 내부에서 무슨 일이 일어나는지 추적합니다.
category: book
part: orientation
audience: [user]
sidebar:
  order: 3
---

`archon-fix-github-issue`를 실행했을 때 정확히 무슨 일이 일어났는지 추적해 봅시다. 하나의 명령처럼 보였지만 실제로는 DAG에서 실행되는 여러 AI node, 공유 workspace, 그리고 단계에서 단계로 맥락을 넘기는 파일 체인의 조합이었습니다.

---

## Workflow 정의

실행한 YAML은 다음과 같습니다. Archon의 내장 기본값에 포함되어 있습니다.

```yaml
name: archon-fix-github-issue

nodes:
  # PHASE 1: CLASSIFY
  - id: classify
    command: archon-investigate-issue
    # Classifies issue type (bug/feature/etc), produces classification artifact

  # PHASE 2: INVESTIGATE or PLAN
  - id: investigate
    command: archon-investigate-issue
    depends_on: [classify]
    context: fresh
    # For bugs: analyzes root cause, creates investigation.md artifact

  # PHASE 3: IMPLEMENT
  - id: implement
    command: archon-fix-issue
    depends_on: [investigate]
    context: fresh
    # Implements fix from investigation, commits (no PR)

  # PHASE 4: CREATE PR
  - id: create-pr
    command: archon-create-pr
    depends_on: [implement]
    context: fresh
    # Pushes branch, creates draft PR linked to issue

  # PHASE 5: REVIEW
  - id: code-review
    command: archon-code-review-agent
    depends_on: [create-pr]
    context: fresh

  # PHASE 6: SELF-FIX
  - id: self-fix
    command: archon-self-fix-all
    depends_on: [code-review]
    context: fresh
    # Reads all review artifacts, fixes findings, pushes fix report
```

전체 구조는 이렇습니다. `nodes:` 아래의 각 항목은 해당 단계에서 AI가 무엇을 해야 하는지 알려 주는 markdown 파일, 즉 **command**를 참조합니다. node는 `depends_on`으로 순서를 표현하고, 독립적인 node는 동시에 실행될 수 있습니다.

---

## 각 단계가 한 일

| 단계 | Command | AI가 한 일 | 생성된 artifact |
|-------|---------|-----------------|-------------------|
| 조사 | `archon-investigate-issue` | GitHub issue를 읽고 관련 코드 파일을 탐색한 뒤 root cause와 수정 계획을 문서화 | `investigation.md` |
| 수정 | `archon-fix-issue` | `investigation.md`를 읽고 코드를 변경하고 테스트를 실행한 뒤 변경을 커밋 | `implementation.md` |
| PR 생성 | `archon-create-pr` | 브랜치를 push하고 자세한 설명이 포함된 issue 연결 pull request 생성 | GitHub의 PR |
| 리뷰 범위 | `archon-pr-review-scope` | PR 메타데이터와 변경 파일 수집 | `.pr-number`, `scope.md` |
| 코드 리뷰 | `archon-code-review-agent` | 전체 코드베이스 맥락으로 diff를 읽고 구조화된 finding 생성 | `review-findings.md` |
| 리뷰 게시 | `archon-post-review-to-pr` | `review-findings.md`를 읽고 PR comment로 게시 | GitHub PR comment |
| 자동 수정 | `archon-auto-fix-review` | 모든 리뷰 artifact를 읽고 드러난 문제를 수정한 뒤 PR 브랜치에 push하고 수정 보고서 게시 | GitHub PR comment |

각 단계는 독립적이고 초점이 분명합니다. 조사 단계는 PR 생성을 알 필요가 없고 파일만 씁니다. 수정 단계는 코드 리뷰를 알 필요가 없고 `investigation.md`를 읽어 변경을 만듭니다. workflow가 이 단계들을 이어 붙입니다.

---

## 핵심 통찰

command는 **원자**입니다. 각각은 plain markdown으로 작성된 하나의 집중된 작업이며, 앞뒤에 무엇이 오는지 알 필요가 없습니다.

workflow는 **분자**입니다. 명확한 목적을 가진 graph로 command를 배치하는 YAML 파일입니다.

**Artifacts**는 연결부입니다. 각 node가 읽을 수 있는 공유 디렉터리(`$ARTIFACTS_DIR`)에 쓰이는 파일입니다. AI가 조사를 마치면 `investigation.md`를 씁니다. 구현 node가 시작되면 그 파일을 읽습니다. 리뷰 node가 실행되면 `implementation.md`를 읽습니다. fresh context를 쓰는 node 사이에서 정보는 이렇게 이동합니다.

각 command는 수동으로도 실행할 수 있습니다. workflow는 그 graph를 자동화합니다.

---

## 파일과 데이터의 위치

Archon은 두 개의 디렉터리 트리를 사용합니다.

```
~/.archon/                                  <- User-level data
├── workspaces/
│   └── owner/repo/
│       ├── source/                         <- Your cloned repo (or symlink)
│       ├── worktrees/                      <- Isolated workspaces per run
│       └── artifacts/                      <- Workflow outputs (never in git)
├── archon.db                               <- SQLite database (conversations, runs)
└── config.yaml                             <- Your global settings
```

```
your-repo/.archon/                          <- Repo-level config (checked into git)
├── commands/                               <- Your custom commands
├── workflows/                              <- Your custom workflows
└── config.yaml                             <- Repo-specific settings
```

`archon-fix-github-issue --branch fix/my-first-run`을 실행하면 Archon은 다음을 수행했습니다.

1. `~/.archon/workspaces/owner/repo/worktrees/fix/my-first-run`에 **worktree**를 만들었습니다.
2. `~/.archon/workspaces/owner/repo/artifacts/` 안에 이 실행을 위한 **artifacts directory**를 만들었습니다.
3. 모든 node를 worktree 안에서 실행했고, `$ARTIFACTS_DIR`은 해당 artifacts directory를 가리켰습니다.

메인 repository는 전혀 건드리지 않았습니다.

---

## Context와 memory

대부분의 node에 `context: fresh`가 있는 것을 볼 수 있습니다. 의도적인 선택입니다.

각 AI node는 Claude Code session 안에서 실행됩니다. 그 session에는 읽은 파일, 실행한 tool call, 대화 기록 같은 context가 쌓입니다. 복잡한 코드베이스 issue를 조사한 뒤에는 그 context가 수천 token에 달할 수 있고, 다음 단계와 무관한 세부사항도 많이 포함됩니다.

`context: fresh`는 해당 node를 새 session으로 시작합니다. AI는 이전 node의 짐을 들고 오지 않습니다. task instructions와 명시적으로 읽는 artifact만 가지고 시작합니다.

그래서 artifact가 중요합니다. "5번 node는 1번 node가 찾은 내용을 어떻게 알까?"라는 질문의 답이 바로 artifact입니다. 파일을 읽는 것입니다. fresh context와 명시적인 파일 handoff입니다.

> **패턴**: 중요한 발견 내용을 artifact에 씁니다. 다음 node는 `context: fresh`로 시작합니다. 그 node가 artifact를 읽게 합니다. 이렇게 하면 각 node가 집중력을 유지하고, 단계 사이에 noise가 누적되는 것을 막을 수 있습니다.

---

이제 시스템의 구조를 이해했습니다. [4장: 핵심 워크플로 →](/book/essential-workflows/)에서는 Archon의 내장 workflow를 모두 살펴보며 언제 어떤 workflow를 선택해야 하는지 정리합니다.
