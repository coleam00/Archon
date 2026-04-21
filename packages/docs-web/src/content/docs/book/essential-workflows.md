---
title: 핵심 워크플로
description: 모든 내장 HarneesLab workflow의 목록과 사용 예시, 언제 어떤 workflow를 써야 하는지에 대한 가이드.
category: book
part: core-workflows
audience: [user]
sidebar:
  order: 4
---

이제 Archon이 어떻게 동작하는지 알게 됐습니다. 다음 질문은 이것입니다. 어떤 workflow를 써야 할까요?

Archon에는 주요 개발 활동을 위한 workflow가 기본으로 포함되어 있습니다. 이 장에서는 여러분의 의도를 적절한 workflow에 연결하고, 각 workflow를 자신 있게 사용할 수 있을 만큼의 세부 정보를 제공합니다.

---

## 어떤 workflow를 써야 하나?

```
무엇을 하고 싶나요?
│
├── 질문하거나 코드베이스 탐색
│   └── archon-assist
│
├── GitHub issue의 버그 수정
│   └── archon-fix-github-issue
│
├── 새 기능 만들기
│   ├── 아이디어나 설명에서 시작 →  archon-idea-to-pr
│   ├── 기존 plan 파일에서 시작  →  archon-plan-to-pr
│   └── 간단한 구현 + PR         →  archon-feature-development
│
├── Pull request 리뷰
│   ├── 적응형(무관한 agent는 건너뜀) →  archon-smart-pr-review
│   └── 항상 모든 agent 실행          →  archon-comprehensive-pr-review
│
├── 코드베이스 architecture 개선
│   └── archon-architect
│
├── PRD를 story 단위로 구현
│   └── archon-ralph-dag
│
└── Merge conflict 해결
    └── archon-resolve-conflicts
```

---

## Workflow 카탈로그

### 질문과 탐색

#### `archon-assist`

다른 범주에 딱 맞지 않는 모든 작업의 출발점입니다. 코드베이스를 대상으로 전체 기능을 사용할 수 있는 단일 Claude Code session을 실행합니다.

**언제 쓰나**: 코드베이스 질문, 디버깅 session, 일회성 작업, 다른 workflow가 맞지 않을 때의 일반적인 도움.

```bash
hlab workflow run archon-assist "What does the orchestrator do?"
hlab workflow run archon-assist "Why are tests failing in the auth module?"
hlab workflow run archon-assist "Explain the isolation system to me"
```

**결과물**: 직접적인 답변. PR도 artifact도 없습니다. AI가 코드 전체 접근 권한을 가지고 질문을 처리합니다.

---

### 버그 수정

#### `archon-fix-github-issue`

2장에서 실행한 workflow입니다. 먼저 issue를 분류합니다(버그, 기능, 개선). 그다음 버그는 조사로, 기능은 계획으로 라우팅합니다. 구현, 검증, draft PR 생성, smart conditional review agent 실행, finding 자동 수정, 변경 단순화, GitHub issue에 완료 보고서 게시까지 수행합니다.

**언제 쓰나**: 모든 GitHub issue. 버그, 기능, 개선 모두에 기본 선택지로 쓰면 됩니다.

```bash
hlab workflow run archon-fix-github-issue --branch fix/login-crash "#142"
```

**결과물**: 수정이 포함된 draft PR, conditional review(코드 리뷰는 항상 실행되고 error handling, test coverage, docs impact, comment quality는 필요할 때만 실행), 적용된 자동 수정, issue의 요약 comment.

---

### 기능 개발

#### `archon-idea-to-pr`

설명에서 시작하는 end-to-end 기능 개발 workflow입니다. 계획을 만들고, 현재 코드베이스 기준으로 여전히 유효한지 확인하고, 구현, 검증, PR 생성, 다섯 개 병렬 review agent 실행, finding 수정, 최종 요약 게시까지 수행합니다.

**언제 쓰나**: 기능 아이디어가 있고, 계획부터 리뷰된 PR까지 Archon이 처리하길 원할 때.

```bash
hlab workflow run archon-idea-to-pr --branch feat/export-csv "Add CSV export to the reports page"
```

**결과물**: merge 준비가 된 PR. plan artifact, implementation artifact, validation result, five-agent review, GitHub comment로 게시된 decision matrix가 포함됩니다.

---

#### `archon-plan-to-pr`

`archon-idea-to-pr`와 같은 pipeline이지만 planning phase를 건너뜁니다. 기존 plan file을 받아 실행합니다.

**언제 쓰나**: 이전 `archon-assist` session, `.agents/plans/` 파일, planning workflow 등에서 만든 계획이 이미 있고 이를 실행하고 싶을 때.

```bash
hlab workflow run archon-plan-to-pr --branch feat/export-csv "Execute .archon/plans/csv-export.md"
```

**결과물**: planning step을 제외한 `archon-idea-to-pr`와 같은 PR 및 review output.

---

#### `archon-feature-development`

더 가벼운 대안입니다. 두 단계로 구성됩니다. plan에서 구현한 뒤 PR을 만듭니다. review pipeline은 없습니다.

**언제 쓰나**: 전체 review overhead 없이 빠르게 구현하고 보내야 할 때. 기존 plan이 있는 단순한 변경에 적합합니다.

```bash
hlab workflow run archon-feature-development --branch feat/update-readme "Implement .archon/plans/readme-update.md"
```

**결과물**: 커밋된 변경이 포함된 PR.

---

### 코드 리뷰

#### `archon-smart-pr-review`

adaptive agent selection으로 현재 PR을 리뷰합니다. 먼저 PR complexity를 분류하고(trivial/small/medium/large), 해당 PR에 필요한 agent만 실행합니다. 세 줄짜리 오타 수정이라면 test-coverage와 docs-impact 분석은 건너뜁니다.

**언제 쓰나**: 대부분의 PR review. 무관한 agent를 건너뛰므로 comprehensive보다 빠릅니다.

```bash
hlab workflow run archon-smart-pr-review "Review PR #87"
```

**결과물**: 종합된 review finding, critical/high issue 자동 수정, 완료 시 선택적 push notification.

---

#### `archon-comprehensive-pr-review`

PR 크기와 관계없이 다섯 개 review agent를 항상 병렬로 실행합니다. code review, error handling, test coverage, comment quality, docs impact를 모두 봅니다.

**언제 쓰나**: 중요한 PR의 pre-merge review처럼 모든 관점을 다루고 싶을 때. 팀 리뷰 프로세스의 일관된 baseline이 필요할 때도 유용합니다.

```bash
hlab workflow run archon-comprehensive-pr-review "Review PR #87"
```

**결과물**: 병렬 five-agent review, 종합된 finding, 적용된 자동 수정.

---

### 코드베이스 건강 상태

#### `archon-architect`

복잡도 hotspot(큰 파일, import fan-out, 함수 길이)을 스캔하고 architecture 관점으로 분석합니다. 목표가 분명한 단순화 계획을 세우고, quality feedback hook과 함께 변경을 만들고, 검증한 뒤 PR을 엽니다.

**언제 쓰나**: 주기적인 코드베이스 health pass. 특정 영역이 다루기 어려울 만큼 커졌을 때. 단순 cleanup이 아니라 원칙 있는 단순화를 원할 때.

```bash
hlab workflow run archon-architect --branch refactor/simplify-orchestrator "Focus on the orchestrator package"
```

**결과물**: 각 변경이 정당화되어 있고 독립적으로 revert 가능한 목표 지향 단순화 PR.

---

### PRD 구현

#### `archon-ralph-dag`

**product requirements document**(PRD)를 story 단위로 구현합니다. 모든 story가 통과할 때까지 loop로 반복합니다.

**언제 쓰나**: 진행 상황을 반복적으로 추적하면서 PRD를 end-to-end로 실행할 때.

```bash
hlab workflow run archon-ralph-dag "Implement .archon/ralph/notifications/prd.md"
```

**결과물**: 하나씩 커밋된 story와 모든 story가 통과한 뒤의 최종 PR.

---

### Merge conflict

#### `archon-resolve-conflicts`

최신 base branch를 fetch하고 conflict를 분석합니다. 단순한 경우는 자동으로 해결하고, 복잡한 경우는 선택지를 제시합니다. 해결 결과를 commit하고 push합니다.

**언제 쓰나**: PR에 merge conflict가 있고 전체 코드베이스 맥락으로 해결 도움을 받고 싶을 때.

```bash
hlab workflow run archon-resolve-conflicts "Resolve conflicts on PR #94"
```

**결과물**: PR 브랜치에 push된 conflict resolution commit.

---

## 빠른 참조

| Workflow | 사용할 때 | PR 생성? | Isolation 사용? |
|----------|----------|-------------|-----------------|
| `archon-assist` | 질문, 탐색, 디버깅 | 아니요 | 아니요 |
| `archon-fix-github-issue` | GitHub issue 수정(smart routing) | 예(draft) | 예 |
| `archon-idea-to-pr` | 설명에서 기능 만들기 | 예 | 예 |
| `archon-plan-to-pr` | 기존 plan 실행 | 예 | 예 |
| `archon-feature-development` | 구현 + 전달(가벼움) | 예 | 예 |
| `archon-smart-pr-review` | 현재 PR 리뷰(adaptive) | 아니요 | 아니요 |
| `archon-comprehensive-pr-review` | 현재 PR 리뷰(모든 agent) | 아니요 | 아니요 |
| `archon-architect` | Architecture sweep | 예 | 예 |
| `archon-ralph-dag` | PRD 구현 loop | 예 | 예 |
| `archon-resolve-conflicts` | Merge conflict 해결 | 아니요 | 아니요 |

---

## 더 많은 workflow 찾기

현재 디렉터리에서 사용할 수 있는 모든 workflow를 보려면:

```bash
hlab workflow list
```

목록에는 Archon의 내장 기본 workflow와 repository의 `.archon/workflows/` 디렉터리에 있는 custom workflow가 함께 표시됩니다. custom workflow는 이름이 같은 내장 workflow를 덮어씁니다. 예를 들어 `archon-assist`라는 workflow를 만들면 내장 버전을 대체합니다.

직접 만들어 볼 준비가 됐나요? [7장: 첫 워크플로 만들기 →](/book/first-workflow/)에서는 처음부터 workflow를 만들어 봅니다. 버전별로 조금씩 확장해 `archon-idea-to-pr`의 미니 버전까지 도달합니다.

그전에 병렬 workflow를 안전하게 만드는 isolation system을 살펴보겠습니다. [5장: 격리와 worktree →](/book/isolation/)로 이어집니다.
