---
title: 시작 안내
description: Archon 한국어 포크를 어디서부터 손대야 하는지 빠르게 정리한 안내 페이지입니다.
---

# 시작 안내

이 포크는 원본 전체를 한 번에 번역하는 방식보다, **랜딩과 구조를 먼저 고정한 뒤 핵심 문서를 순차적으로 한글화**하는 방식이 안전합니다.

## 권장 순서

1. 홈 랜딩과 사이드바 구조를 먼저 정리합니다.
2. [포크 준비 체크](/korean-fork/fork-readiness/)로 원격, 브랜치, 배포 기준을 먼저 확인합니다.
3. [우선 번역 백로그](/korean-fork/translation-backlog/)에서 첫 문서 묶음을 정합니다.
4. [한글화 용어집](/korean-fork/glossary/)으로 표현을 고정합니다.
5. [한글화 로드맵](/korean-fork/roadmap/) 기준으로 우선 문서를 번역합니다.
6. 이후에 `README`, Getting Started, CLI 문서를 순서대로 한글화합니다.

## 지금 바로 보면 좋은 페이지

- [한국어 포크 개요](/korean-fork/)
- [포크 준비 체크](/korean-fork/fork-readiness/)
- [우선 번역 백로그](/korean-fork/translation-backlog/)
- [한글화 로드맵](/korean-fork/roadmap/)
- [한글화 용어집](/korean-fork/glossary/)

## 현재 구조에서의 역할

- `packages/docs-web`
  랜딩 페이지와 문서 사이트
- `packages/web`
  실제 웹 앱 인터페이스
- `packages/cli`, `packages/core`, `packages/workflows`
  제품 핵심 로직
- `.archon/`
  워크플로와 명령 확장

## 다음 번 작업 후보

- 홈 랜딩의 CTA를 더 강하게 정리
- 포크 운영 체크리스트를 실제 작업 플로우에 맞게 세분화
- README와 Getting Started 중 어떤 묶음을 먼저 번역할지 결정
- `README.md` 한국어 버전 초안 만들기
- Getting Started 섹션 1차 번역
- CLI 핵심 명령 표를 한국어로 재구성
