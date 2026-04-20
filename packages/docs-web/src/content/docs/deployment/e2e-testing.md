---
title: E2E Testing
description: HarnessLab workflow에서 end-to-end browser testing을 위해 agent-browser를 설정합니다.
category: deployment
area: infra
audience: [developer, operator]
status: current
sidebar:
  order: 5
---

HarnessLab은 `archon-validate-pr` 같은 workflow의 end-to-end browser testing에 Vercel Labs의 [agent-browser](https://github.com/vercel-labs/agent-browser)를 사용합니다. 이는 **선택적** external dependency이며, 핵심 HarnessLab 기능은 agent-browser 없이도 동작합니다.

## 설치

```bash
# Install globally
npm install -g agent-browser

# Download browser engine (Chrome for Testing)
agent-browser install
```

## 설치 확인

```bash
agent-browser --version
# Expected: prints version number (e.g., 0.x.x)

# Quick smoke test — opens a page and closes
agent-browser open https://example.com
agent-browser close
```

## 사용되는 곳

다음 workflow와 command는 agent-browser에 의존합니다.

| Resource | Type | 용도 |
|----------|------|---------|
| `archon-validate-pr` | Workflow | PR validation의 E2E testing phase |
| `validate-ui` | Skill | 종합 UI testing |
| `replicate-issue` | Skill | browser를 통한 issue reproduction |
| `archon-validate-pr-e2e-main.md` | Command | main branch 대상 E2E test |
| `archon-validate-pr-e2e-feature.md` | Command | feature branch 대상 E2E test |

## 플랫폼별 참고사항

### Docker

HarnessLab Docker image에는 agent-browser가 **미리 설치**되어 있습니다. 별도 작업은 필요하지 않습니다.

### macOS / Linux

위 설치 command를 실행하면 native로 동작합니다. daemon 시작에 실패하면 다음을 실행합니다.

```bash
# Kill stale daemons and retry
pkill -f daemon.js
agent-browser open http://localhost:3090
```

### Windows

agent-browser에는 Windows의 Unix domain socket 비호환성 때문에 daemon 시작에 실패하는 [known bug](https://github.com/vercel-labs/agent-browser/issues/56)가 있습니다.

**Workaround:** dev server는 Windows에서 실행하고 agent-browser는 WSL 안에서 실행합니다. 자세한 설정은 [WSL에서 E2E Testing](/deployment/e2e-testing-wsl/) 가이드를 참고하세요.

## agent-browser 없이 실행하기

agent-browser가 설치되어 있지 않으면 agent가 `agent-browser`를 호출하려 할 때 E2E workflow node가 실패합니다. AI agent에게는 prompt를 통해 connection attempt가 2번 실패하면 중단하고 code-review-only report를 만들도록 지시되어 있습니다. 하지만 이는 자동 workflow logic이 아니라 prompt-level instruction입니다. 결과는 AI model이 지시를 얼마나 따르는지에 따라 달라질 수 있습니다.

agent-browser가 설치되어 있지 않아도 모든 non-E2E workflow는 안전하게 실행할 수 있습니다.
