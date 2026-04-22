---
title: 전역 워크플로
description: 이 컴퓨터의 모든 프로젝트에 적용되는 사용자 수준 워크플로를 정의합니다.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 8
---

`~/.archon/.archon/workflows/`에 둔 workflow는 전역으로 로드됩니다. 모든 프로젝트의 `workflow list`에 표시되며 어느 저장소에서든 실행할 수 있습니다. HarneesLab은 Archon fork compatibility 때문에 기본 user-level home 경로로 `~/.archon`을 계속 사용합니다.

## 경로

```
~/.archon/.archon/workflows/
```

또는 `HARNEESLAB_HOME`을 설정했다면 다음 경로를 사용합니다.

```
$HARNEESLAB_HOME/.archon/workflows/
```

`ARCHON_HOME`은 legacy fallback으로 계속 지원됩니다.

디렉터리가 없다면 생성하세요.

```bash
mkdir -p ~/.archon/.archon/workflows
```

## 로드 우선순위

1. **기본 제공 워크플로**(가장 낮은 우선순위)
2. **전역 workflow** -- `~/.archon/.archon/workflows/`(파일명이 같으면 기본 제공 workflow를 덮어씀)
3. **저장소별 workflow** -- `.archon/workflows/`(파일명이 같으면 전역 workflow를 덮어씀)

전역 workflow가 기본 제공 workflow와 같은 파일명을 가지면 전역 버전이 사용됩니다. 저장소별 workflow가 전역 workflow와 같은 파일명을 가지면 저장소별 버전이 사용됩니다.

## 실전 예시

전역 workflow는 프로젝트와 관계없이 항상 적용하고 싶은 개인 기준을 강제할 때 유용합니다.

### 개인 코드 리뷰

모든 프로젝트에서 선호하는 리뷰 체크리스트를 실행하는 workflow입니다.

```yaml
# ~/.archon/.archon/workflows/my-review.yaml
name: my-review
description: Personal code review with my standards
model: sonnet

nodes:
  - id: review
    prompt: |
      Review the changes on this branch against main.
      Check for: error handling, test coverage, naming conventions,
      and unnecessary complexity. Be direct and specific.
```

### 커스텀 린팅 또는 포맷 검사

프로젝트에 종속되지 않는 검사를 실행하는 workflow입니다.

```yaml
# ~/.archon/.archon/workflows/lint-check.yaml
name: lint-check
description: Check for common code quality issues across any project

nodes:
  - id: check
    prompt: |
      Scan this codebase for:
      1. Functions longer than 50 lines
      2. Deeply nested conditionals (>3 levels)
      3. TODO/FIXME comments without issue references
      Report findings as a prioritized list.
```

### 빠른 설명

익숙하지 않은 코드베이스를 이해하기 위한 간단한 workflow입니다.

```yaml
# ~/.archon/.archon/workflows/explain.yaml
name: explain
description: Quick explanation of a codebase or module
model: haiku

nodes:
  - id: explain
    prompt: |
      Give a concise explanation of this codebase.
      Focus on: what it does, key entry points, and how the main
      pieces connect. Keep it under 500 words.
      Topic: $ARGUMENTS
```

## Dotfiles와 동기화

설정을 dotfiles 저장소로 관리한다면 전역 workflow도 함께 포함할 수 있습니다.

```bash
# In your dotfiles repo
dotfiles/
└── archon/
    └── .archon/
        └── workflows/
            ├── my-review.yaml
            └── explain.yaml
```

그런 다음 dotfiles 설정 과정에서 symlink를 만듭니다.

```bash
ln -sf ~/dotfiles/archon/.archon/workflows ~/.archon/.archon/workflows
```

또는 dotfiles 설치 스크립트의 일부로 복사할 수도 있습니다.

```bash
mkdir -p ~/.archon/.archon/workflows
cp ~/dotfiles/archon/.archon/workflows/*.yaml ~/.archon/.archon/workflows/
```

이렇게 하면 개인 workflow를 여러 컴퓨터에서 함께 사용할 수 있습니다.

## CLI 지원

CLI와 서버는 모두 전역 워크플로를 자동으로 발견합니다.

```bash
# bundled + global + repo-specific workflows 표시
hlab workflow list

# 어느 repo에서든 global workflow 실행
hlab workflow run my-review
```

## 문제 해결

### Workflow가 목록에 표시되지 않음

1. **경로 확인** -- 디렉터리는 정확히 `~/.archon/.archon/workflows/`여야 합니다(`.archon`이 두 번 나오는 점에 주의). 첫 번째 `.archon`은 compatibility home directory이고, 두 번째 `.archon`은 그 안의 표준 config directory structure입니다.

   ```bash
   ls ~/.archon/.archon/workflows/
   ```

2. **파일 확장자 확인** -- Workflow 파일은 `.yaml` 또는 `.yml`로 끝나야 합니다.

3. **YAML 유효성 확인** -- YAML syntax error가 있으면 workflow list가 아니라 errors list에 표시됩니다. 다음 명령을 실행하세요.

   ```bash
   hlab validate workflows my-workflow
   ```

4. **이름 충돌 확인** -- 저장소별 workflow가 같은 파일명을 가지면 전역 workflow를 덮어씁니다. 해당 저장소 안에서는 전역 버전이 표시되지 않습니다.

5. **HARNEESLAB_HOME / ARCHON_HOME 확인** -- `HARNEESLAB_HOME` 또는 `ARCHON_HOME`을 커스텀 경로로 설정했다면 전역 workflow는 `~/.archon/.archon/workflows/`가 아니라 해당 home directory 아래의 `.archon/workflows/`에 있어야 합니다.
