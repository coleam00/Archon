---
title: 설치
description: macOS, Linux, Windows에서 HarneesLab을 설치합니다.
category: getting-started
audience: [user, operator]
sidebar:
  order: 0
---

## 빠른 설치

### macOS / Linux

```bash
curl -fsSL https://harneeslab.codewithgenie.com/install | bash
```

### Windows (PowerShell)

```powershell
irm https://harneeslab.codewithgenie.com/install.ps1 | iex
```

### Homebrew (macOS / Linux)

```bash
brew install <tap>/hlab
```

### Docker

```bash
docker run --rm -v "$PWD:/workspace" ghcr.io/newturn2017/harneeslab:latest workflow list
```

## 소스에서 설치

```bash
git clone https://github.com/NewTurn2017/HarneesLab
cd HarneesLab
bun install
```

### 사전 요구사항(Source Install)

- [Bun](https://bun.sh) >= 1.0.0
- [GitHub CLI](https://cli.github.com/) (`gh`)
- [Claude Code](https://claude.ai/code) (`claude`)

## Claude Code 설정

HarneesLab은 Claude Code를 orchestration하지만, Claude Code를 함께 포함하지는 않습니다. Claude Code는 별도로 설치해야 합니다.

```bash
# macOS / Linux / WSL (Anthropic's recommended installer)
curl -fsSL https://claude.ai/install.sh | bash

# Windows (PowerShell)
irm https://claude.ai/install.ps1 | iex
```

source install(`bun run`)은 `node_modules`를 통해 실행 파일을 자동으로 찾습니다. compiled HarneesLab binary(quick install, Homebrew)는 Claude Code 실행 파일 위치를 직접 지정해야 합니다.

```bash
# After the native installer:
export CLAUDE_BIN_PATH="$HOME/.local/bin/claude"

# After `npm install -g @anthropic-ai/claude-code`:
export CLAUDE_BIN_PATH="$(npm root -g)/@anthropic-ai/claude-code/cli.js"
```

또는 `~/.archon/config.yaml`에 지속 설정으로 저장할 수 있습니다. HarneesLab은 compatibility를 위해 이 기본 경로를 유지합니다.

```yaml
assistants:
  claude:
    claudeBinaryPath: /absolute/path/to/claude
```

Docker image(`ghcr.io/newturn2017/harneeslab`)에는 Claude Code가 미리 설치되어 있고
`CLAUDE_BIN_PATH`도 미리 설정되어 있으므로 별도 설정이 필요 없습니다.

자세한 내용과 install layout별 경로는 [AI Assistants → Claude Code](/getting-started/ai-assistants/#binary-path-configuration-compiled-binaries-only)를 참고하세요.

## 설치 확인

```bash
hlab version
```

## 다음 단계

- [핵심 개념](/getting-started/concepts/) — workflow, node, command, isolation 이해하기
- [빠른 시작](/getting-started/quick-start/) — 첫 workflow 실행하기
- [설정](/getting-started/configuration/) — API key와 preference 설정하기
