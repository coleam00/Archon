---
title: 격리와 worktree
description: Archon이 git worktree를 사용해 여러 workflow를 충돌 없이 병렬 실행하는 방식.
category: book
part: core-workflows
audience: [user]
sidebar:
  order: 5
---

4장에서 대부분의 workflow가 `--branch` flag를 받는 것을 봤을 것입니다. 이 flag는 단순히 브랜치 이름을 지정하는 것이 아닙니다. Archon이 여러 작업을 서로 밟지 않고 동시에 실행하게 해 주는 **isolation** system을 활성화합니다.

---

## Isolation이 중요한 이유

issue #42에 대해 `archon-fix-github-issue`를 실행하고 있는데 issue #43도 같이 시작한다고 생각해 봅시다. isolation이 없으면 두 작업은 repository의 같은 파일을 공유합니다. 작업 A가 `auth.ts`를 수정합니다. 작업 B도 `auth.ts`를 수정합니다. 실행 중간에 conflict가 생기고, Archon은 어떤 변경이 어떤 작업에 속하는지 판단하기 어려워집니다.

isolation을 사용하면 각 작업은 자기만의 **worktree**를 갖습니다. 파일이 분리된 완전히 별도의 디렉터리입니다. 작업 A는 한 디렉터리에서, 작업 B는 다른 디렉터리에서 진행됩니다. 서로의 진행 중 변경을 보지 않습니다. 실행 중에는 메인 repository가 전혀 건드려지지 않습니다.

이것이 Archon을 밤새 안전하게 실행할 수 있는 이유이기도 합니다. 한 시간이 걸리고 수십 개 변경을 만드는 workflow도 모두 격리 상태에서 수행됩니다. 끝나면 PR을 검토하고, 마음에 들지 않으면 닫으면 됩니다. 여러분의 작업 디렉터리는 영향을 받지 않았습니다.

---

## Worktree 동작 방식

**worktree**는 같은 repository에 연결된 별도 checkout 디렉터리를 만드는 Git 기능입니다. clone이 아닙니다. 메인 repository와 Git history, object, remote를 공유합니다. 같은 코드베이스를 별도 브랜치에서 바라보는 두 번째 창에 가깝습니다.

Archon이 workflow 실행을 위해 worktree를 만들면 다음 위치에 생성됩니다.

```
~/.archon/workspaces/
└── owner/repo/
    └── worktrees/
        ├── fix/issue-42/     <- task A's workspace
        └── feat/dark-mode/   <- task B's workspace
```

각 worktree는 완전히 동작하는 checkout입니다. AI는 그 디렉터리 안에서 파일을 읽고, 테스트를 실행하고, 코드를 수정하고, commit할 수 있습니다. 작업이 끝나 PR을 만들면 worktree의 브랜치가 GitHub로 push됩니다. 그 후에는 안전하게 정리할 수 있습니다.

---

## Isolation이 적용되는 시점

`workflow run` 명령의 flag로 isolation 동작을 제어합니다.

| 명령 패턴 | 동작 |
|-----------------|----------|
| `archon workflow run <name> "..."` | 브랜치 이름을 자동 생성하고 격리된 worktree에서 실행 |
| `archon workflow run <name> --branch my-branch "..."` | 지정한 브랜치 이름을 사용하고 격리된 worktree에서 실행 |
| `archon workflow run <name> --no-worktree "..."` | isolation 없이 현재 디렉터리에서 직접 실행 |

**기본값은 isolation입니다.** `--no-worktree`를 넘기지 않으면 Archon이 worktree를 만듭니다.

`--no-worktree`는 코드 수정이 없는 작업에만 사용하세요. 질문, 탐색, `archon-assist` 실행 같은 경우입니다. 파일을 건드리는 모든 작업에는 isolation이 맞습니다.

> **권장**: 코드를 변경하는 workflow에는 항상 설명적인 이름과 함께 `--branch`를 사용하세요. 나중에 worktree를 식별하기 쉽고 GitHub에서도 깔끔한 브랜치 이름이 만들어집니다.

---

## Worktree 관리하기

worktree는 시간이 지나며 쌓입니다. Archon은 이를 관리하기 위한 몇 가지 명령을 제공합니다.

### 활성 worktree 보기

```bash
archon isolation list
```

모든 활성 worktree의 브랜치 이름, 경로, 생성 시간, 상태를 보여 줍니다.

### 오래된 worktree 정리

```bash
archon isolation cleanup
```

7일보다 오래된 worktree를 제거합니다. 숫자를 넘기면 기준을 바꿀 수 있습니다.

```bash
archon isolation cleanup 14   # Remove worktrees older than 14 days
```

이미 main branch에 merge된 브랜치의 worktree를 제거하려면:

```bash
archon isolation cleanup --merged
```

이 명령은 remote branch도 삭제합니다. PR 라운드가 끝난 뒤 깔끔하게 정리할 수 있습니다.

기본적으로 열려 있거나 merge 없이 닫힌 PR이 있는 브랜치는 실수로 삭제하지 않도록 건너뜁니다. abandoned(CLOSED) PR도 함께 정리하려면:

```bash
archon isolation cleanup --merged --include-closed
```

### 브랜치 lifecycle 완료

PR이 merge된 뒤 worktree, local branch, remote branch를 모두 제거하려면 `complete`를 사용합니다.

```bash
archon complete fix/issue-42
```

이것이 전체 lifecycle 종료입니다. merge 후 실행하면 깨끗한 상태로 돌아갑니다.

> **안전 참고**: Archon은 uncommitted change가 있는 worktree를 제거하지 않습니다. `cleanup`이 worktree를 건너뛰면 수동 삭제 전에 `archon isolation list`로 확인하세요.

---

## Best practices

**코드 변경에는 항상 `--branch`를 사용하세요.** 자동 생성 브랜치 이름도 동작하지만 `fix/login-crash`, `feat/csv-export`처럼 설명적인 이름이 훨씬 추적하기 쉽습니다.

**merge 후 정리하세요.** PR이 반영되면 `archon complete <branch>` 또는 `archon isolation cleanup --merged`를 실행하세요. worktree 몇 개는 괜찮지만 오래된 것이 수십 개 쌓이면 혼란스러워집니다.

**`--no-worktree`는 read-only 작업에만 사용하세요.** 질문, 분석, 탐색은 isolation 없이도 안전합니다. 파일을 쓰는 작업은 worktree에서 실행해야 합니다.

**같은 브랜치를 동시에 두 번 실행하지 마세요.** 각 브랜치 이름은 정확히 하나의 worktree에 대응합니다. 같은 브랜치에서 두 번째 workflow를 시작하면 첫 번째와 충돌합니다.

---

isolation이 작업을 어떻게 보호하는지 이해했으니 이제 만들 준비가 됐습니다. [6장: 첫 명령 만들기 →](/book/first-command/)에서는 Archon의 원자 단위인 command file을 처음부터 작성합니다.
