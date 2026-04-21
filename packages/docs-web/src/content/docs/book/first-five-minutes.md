---
title: 처음 5분
description: 5분 안에 내 코드베이스에서 첫 HarneesLab workflow를 실행합니다.
category: book
part: orientation
audience: [user]
sidebar:
  order: 2
---

이론은 잠시 미루고 바로 성과를 만들어 봅시다. 이 장이 끝날 때쯤이면 여러분의 코드베이스에서 실제 HarneesLab workflow 두 개를 실행해 보게 됩니다.

---

## 준비 사항

시작하기 전에 다음이 준비되어 있는지 확인하세요.

- [ ] **Git** 설치됨 (`git --version`이 동작해야 합니다)
- [ ] **Bun** 설치됨 — 없다면 [bun.sh](https://bun.sh)에서 설치하세요 (`bun --version`)
- [ ] **Claude Code** 설치 및 인증 완료 — 아직이라면 `claude /login`을 실행하세요
- [ ] workflow를 실행할 **git repository** — 어떤 프로젝트든 괜찮습니다

> **이미 Claude Code를 쓰고 있나요?** 그렇다면 이미 인증되어 있습니다. API key나 추가 설정은 필요 없습니다. HarneesLab은 같은 인증 정보를 사용합니다.

---

## HarneesLab 설치하기 (60초)

```bash
# Clone and install
git clone https://github.com/NewTurn2017/HarneesLab.git
cd HarneesLab
bun install

# Register the archon command globally
cd packages/cli && bun link && cd ../..

# Verify it worked
hlab version
```

`archon v0.2.12` 같은 출력이 보이면 됩니다. 이것으로 HarneesLab 설치가 끝났습니다.

> **`bun link` 후에도 `archon`을 찾지 못한다면:** shell을 다시 로드해야 할 수 있습니다. `source ~/.zshrc` 또는 `~/.bashrc`를 실행한 뒤 다시 시도하세요. 또는 이번 세션에서는 `HarneesLab` 디렉터리 안에서 `bun run cli`를 사용할 수 있습니다.

---

## 첫 성과: 질문하기 (90초)

내 컴퓨터의 아무 git repository로 이동한 뒤 실행합니다.

```bash
cd /path/to/your/project

hlab workflow run archon-assist "What's the entry point for this application?"
```

HarneesLab은 코드베이스를 분석하고 전체 맥락을 바탕으로 질문에 답합니다. 터미널에는 파일을 살펴보며 생각하는 과정이 실시간으로 스트리밍됩니다.

**방금 첫 HarneesLab workflow를 실행했습니다.** 단일 단계 workflow입니다. 하나의 command, 하나의 AI 호출, 하나의 답변. 단순하지만 유용합니다.

> **팁:** `archon-assist`는 어떤 질문에도 사용할 수 있습니다. "How does auth work?", "Where is the database configured?", "What does this function do?"처럼 물어보세요. 언제든 부를 수 있는 코드베이스 전문가입니다.

---

## 두 번째 성과: issue 수정하기 (2분)

repository에 열린 GitHub issue가 있다면 다음을 시도해 보세요.

```bash
hlab workflow run archon-fix-github-issue --branch fix/my-first-run "Fix #<issue-number>"
```

`<issue-number>`를 실제 issue 번호로 바꿉니다. 그리고 어떤 일이 일어나는지 보세요.

1. **조사** — HarneesLab이 issue를 읽고 관련 코드를 탐색한 뒤 발견 내용을 문서화합니다.
2. **구현** — 조사 결과를 바탕으로 수정합니다.
3. **검증** — 테스트를 실행해 깨진 부분이 없는지 확인합니다.
4. **PR 생성** — 자세한 설명이 포함된 pull request를 엽니다.

**방금 네 단계 자동화 workflow를 실행했습니다.** 각 단계는 별도 command로 실행되고, artifact를 다음 단계로 넘깁니다. PR은 이제 여러분의 리뷰를 기다립니다.

> **마땅한 GitHub issue가 없나요?** 아무 웹 프로젝트에서 `hlab workflow run archon-feature-development --branch feat/test "Add a simple hello world endpoint"`를 실행해 보세요. 기능을 구현하고 PR을 만듭니다.

---

## 방금 무슨 일이 일어났나?

방금 실행한 두 명령은 겉보기보다 많은 일을 했습니다. HarneesLab은 workflow 정의를 로드하고, 격리된 git workspace를 만들고, 여러 AI 단계를 순서대로 실행하고, **artifacts**라는 파일을 통해 단계들을 연결했습니다.

[3장: HarneesLab은 실제로 어떻게 동작하나 →](/book/how-it-works/)에서는 방금 일어난 일을 단계별, 파일별로 추적합니다. 여러분이 다루는 시스템을 정확히 이해하게 될 것입니다.
