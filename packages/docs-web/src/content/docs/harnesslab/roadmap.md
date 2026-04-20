---
title: 한글화 로드맵
description: HarnessLab의 초기 작업 순서와 기준을 정리합니다.
---

# 한글화 로드맵

## 1단계: 포크 기반 정리

- 포크 저장소를 작업 원점으로 고정
- `origin`과 `upstream` 역할 분리
- `dev` 기반에서만 기능 브랜치 생성
- GitHub Pages 또는 별도 도메인 전략 결정

## 2단계: 랜딩 페이지 한국어화

- 홈 스플래시 문구를 한국어 기준으로 재작성
- CTA를 학습용, 강의용, 실전 적용용 관점으로 정리
- GitHub 포크와 문서 시작 페이지 링크를 명확히 노출
- 필요하면 `packages/docs-web`에 사례 페이지를 추가

## 3단계: 문서 번역 우선순위

- `README.md`
- `packages/docs-web/src/content/docs/getting-started/*`
- `packages/docs-web/src/content/docs/reference/cli.md`
- `packages/docs-web/src/content/docs/guides/authoring-workflows.md`

## 4단계: 용어집 확정

권장 초안:

- workflow: 워크플로
- worktree: 워크트리
- adapter: 어댑터
- approval gate: 승인 게이트
- loop node: 루프 노드
- command: 명령
- run: 실행

번역은 직역보다 **한국어 개발자가 바로 행동으로 옮길 수 있는 표현**을 우선합니다.

## 5단계: 실험용 개선

- 한국어 기본 명령 세트 추가
- 강의용 데모 워크플로 정리
- 국내 사용 환경에 맞는 설치/배포 가이드 보강
- 연구 메모와 실제 구현 결과를 문서에 연결

## 운영 원칙

- 원본과의 차별점은 문서와 운영 경험에서 먼저 만든다
- 제품 코드 변경은 작은 브랜치로 나눈다
- 번역과 기능 개선을 한 커밋에 섞지 않는다
- 업스트림 동기화는 자주 하되, 브랜드와 문서 방향은 포크에서 독립적으로 유지한다
