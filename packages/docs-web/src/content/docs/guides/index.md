---
title: 가이드
description: Archon에서 워크플로, 명령, 노드 기능을 작성하고 설정하는 방법을 다루는 가이드입니다.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 0
---

Archon으로 AI 코딩 워크플로를 만들고 실행하는 방법을 다루는 가이드입니다. HarnessLab은 Archon fork로서, 반복 가능한 에이전트 워크플로를 학습하고 실무에 적용하기 쉽게 정리합니다.

## 워크플로 작성

- [워크플로 작성](/guides/authoring-workflows/) — DAG 노드, 조건부 분기, 병렬 실행을 사용하는 다단계 YAML 워크플로를 만듭니다
- [명령 작성](/guides/authoring-commands/) — 워크플로 노드의 구성 요소가 되는 프롬프트 템플릿을 작성합니다

## 노드 유형

- [Loop 노드](/guides/loop-nodes/) — 완료 조건과 결정적 종료 검사를 갖춘 반복 AI 실행
- [Approval 노드](/guides/approval-nodes/) — 거절 시 선택적으로 AI 재작업을 수행하는 사람 검토 게이트

## 노드 기능(Claude 전용)

- [노드별 Hooks](/guides/hooks/) — 도구 제어, 컨텍스트 주입, 입력 수정을 위해 Claude SDK hooks를 연결합니다
- [노드별 MCP Servers](/guides/mcp-servers/) — 외부 도구(GitHub, Postgres 등)를 개별 노드에 연결합니다
- [노드별 Skills](/guides/skills/) — 노드 에이전트에 전문 지식을 미리 로드합니다

## 기본 제공 워크플로

Archon에는 자주 쓰는 코딩 작업을 처리하는 즉시 사용 가능한 워크플로가 포함되어 있습니다. 이를 사용하기 위해 YAML을 직접 작성할 필요는 없습니다. 원하는 작업을 설명하면 라우터가 적절한 워크플로를 선택합니다.

| Workflow | 수행 작업 |
|----------|-------------|
| `archon-assist` | 일반 Q&A, 디버깅, 탐색을 처리하는 범용 워크플로 |
| `archon-fix-github-issue` | 조사, 근본 원인 파악, 수정 구현, 검증, PR 생성 |
| `archon-smart-pr-review` | 복잡도에 따라 조정되는 PR 리뷰 |
| `archon-comprehensive-pr-review` | 다중 에이전트 PR 리뷰(병렬 리뷰어 5개) |
| `archon-feature-development` | 계획에 따라 기능을 구현하고 검증한 뒤 PR 생성 |
| `archon-create-issue` | 문제를 조사하고 GitHub issue 생성 |
| `archon-validate-pr` | 철저한 PR 검증 테스트 |
| `archon-resolve-conflicts` | PR의 merge conflict 감지 및 해결 |
| `archon-remotion-generate` | AI로 Remotion video composition 생성 또는 수정 |
| `archon-interactive-prd` | 안내형 대화를 통해 PRD 작성 |
| `archon-piv-loop` | 사람이 중간에 참여하는 Plan-Implement-Validate 안내형 루프 |
| `archon-adversarial-dev` | adversarial development 방식으로 완전한 애플리케이션을 처음부터 구축 |

전체 목록과 설명은 Overview의 [사용 가능한 워크플로 표](/getting-started/overview/#available-workflows)를 참고하세요.

기본 제공 워크플로를 커스터마이즈하려면 `.archon/workflows/defaults/`에서 프로젝트의 `.archon/workflows/`로 복사한 뒤 수정하세요. 같은 이름의 파일은 기본값을 덮어씁니다.

## 고급

- [전역 워크플로](/guides/global-workflows/) — 모든 프로젝트에 적용되는 사용자 수준 워크플로
- [Remotion 비디오 생성](/guides/remotion-workflow/) — skills와 bash render 노드를 사용하는 엔드투엔드 비디오 생성
