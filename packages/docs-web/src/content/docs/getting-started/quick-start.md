---
title: 빠른 시작
description: 몇 분 안에 첫 HarneesLab workflow를 실행합니다.
category: getting-started
audience: [user]
sidebar:
  order: 2
---

## 사전 요구사항

1. [HarneesLab 설치](/getting-started/installation/)
2. [Claude Code 설치](/getting-started/ai-assistants/#claude-code) — HarneesLab은 Claude Code를 orchestration하지만 함께 포함하지는 않습니다
3. Claude 인증을 진행합니다: `claude /login` 실행(기존 Claude Pro/Max subscription 사용)
4. compiled HarneesLab binary에서는 `CLAUDE_BIN_PATH`를 설정합니다([Binary path configuration](/getting-started/ai-assistants/#binary-path-configuration-compiled-binaries-only) 참고)
5. 임의의 git repository로 이동합니다

## 첫 Workflow 실행

```bash
# 사용 가능한 workflow 목록 확인
hlab workflow list

# HarneesLab에 codebase 설명 요청
hlab workflow run archon-assist "What does this codebase do?"

# PR/code review workflow 실행
hlab workflow run archon-smart-pr-review
```

## 다음 단계

설치, 인증, Web UI 설정, CLI 설정, troubleshooting까지 포함한 전체 시작 가이드는 [개요](/getting-started/overview/)를 참고하세요.

- [개요](/getting-started/overview/) — 전체 onboarding guide
- [핵심 개념](/getting-started/concepts/) — workflow, node, command, isolation 이해하기
- [설정](/getting-started/configuration/) — 프로젝트에 맞게 HarneesLab 설정하기
- [Workflow 작성](/guides/authoring-workflows/) — 나만의 workflow 만들기
- [GitHub Repository](https://github.com/NewTurn2017/HarneesLab) — source code, issue, discussion
