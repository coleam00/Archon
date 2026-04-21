---
title: 우선 번역 백로그
description: HarneesLab에서 먼저 손댈 문서 묶음과 이유를 정리한 실행용 백로그입니다.
---

# 우선 번역 백로그

이 페이지는 HarneesLab에서 문서 번역을 어디서부터 시작할지 결정하기 위한 **실행 순서표**입니다. 지금 단계에서는 전체 번역보다, 영향도가 큰 문서부터 작은 묶음으로 나누어 진행하는 것이 중요합니다.

## 1차 우선순위

### README

- 이유: GitHub 첫 화면에서 프로젝트 성격을 바로 설명해야 함
- 범위: 소개, 왜 Archon인가, Getting Started, Web UI, 주요 워크플로 요약
- 목표: 포크 방문자가 한국어 프로젝트 방향을 3분 안에 이해할 수 있게 만들기

### Getting Started

- 이유: 실제 사용자가 가장 먼저 막히는 구간
- 범위: `installation`, `overview`, `quick-start`
- 목표: 설치부터 첫 실행까지 한국어 기준으로 연결

### CLI 핵심 레퍼런스

- 이유: 학습보다 실전 적용에서 자주 다시 찾게 되는 문서
- 범위: `reference/cli.md`에서 기본 명령과 대표 예시 우선
- 목표: 자주 쓰는 명령을 한국어 설명으로 빠르게 검색 가능하게 만들기

## 2차 우선순위

### 워크플로 작성 가이드

- 대상: `guides/authoring-workflows.md`
- 이유: Archon의 차별점이 가장 강하게 드러나는 문서

### 핵심 개념 문서

- 대상: `getting-started/concepts.md`
- 이유: 강의용 설명과 실전 적용용 설명을 연결하기 좋음

## 작업 단위 기준

- 한 번에 문서 한 섹션 또는 한 페이지씩만 번역
- 번역 PR 또는 커밋은 주제를 섞지 않기
- 링크, 코드 블록, 경로, 명령어는 번역하지 않기
- 번역 전에 [한글화 용어집](/harneeslab/glossary/)을 먼저 확인

## 권장 착수 순서

1. `README.md`
2. `packages/docs-web/src/content/docs/getting-started/installation.md`
3. `packages/docs-web/src/content/docs/getting-started/overview.md`
4. `packages/docs-web/src/content/docs/reference/cli.md`

## 선택 기준

먼저 무엇을 번역할지 고민될 때는 아래 기준으로 결정하면 됩니다.

- GitHub 방문자 인상이 중요하면 `README`
- 실제 설치와 체험 흐름이 중요하면 Getting Started
- 실무 활용성과 재검색성이 중요하면 CLI 레퍼런스
