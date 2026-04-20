---
title: AI 어시스턴트
description: Archon에서 AI assistant로 Claude Code, Codex, Pi를 설정합니다.
category: getting-started
area: clients
audience: [user]
status: current
sidebar:
  order: 4
---

**최소 하나의** AI assistant는 반드시 설정해야 합니다. 세 가지를 모두 설정하고 workflow 안에서 섞어 사용할 수도 있습니다.

HarnessLab은 Archon fork이므로 assistant provider 이름, config key, CLI 명령은 upstream Archon과 동일하게 유지합니다.

## Claude Code

**Claude Pro/Max 구독자에게 권장합니다.**

HarnessLab은 Claude Code를 bundle하지 않습니다. 별도로 설치한 뒤, compiled HarnessLab binaries에서는 HarnessLab이 해당 실행 파일을 가리키도록 설정해야 합니다. dev(`bun run`)에서는 HarnessLab이 `node_modules`를 통해 자동으로 찾습니다.

### Claude Code 설치

Anthropic의 native installer가 기본 권장 설치 경로입니다.

**macOS / Linux / WSL:**

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://claude.ai/install.ps1 | iex
```

**대체 설치 방법:**

- macOS via Homebrew: `brew install --cask claude-code`
- npm (any platform): `npm install -g @anthropic-ai/claude-code`
- Windows via winget: `winget install Anthropic.ClaudeCode`

설치 경로별 전체 목록과 auto-update 주의사항은 [Anthropic's setup guide](https://code.claude.com/docs/en/setup)를 참고하세요.

<a id="binary-path-configuration-compiled-binaries-only"></a>

### Binary path 설정 (compiled binaries only)

compiled HarnessLab binaries는 runtime에 Claude Code를 자동 탐색할 수 없습니다. 다음 중 하나로 path를 제공하세요.

1. **Environment variable** (가장 높은 우선순위):
   ```ini
   CLAUDE_BIN_PATH=/absolute/path/to/claude
   ```
2. **Config file** (`~/.archon/config.yaml` 또는 repo-local `.archon/config.yaml`):
   ```yaml
   assistants:
     claude:
       claudeBinaryPath: /absolute/path/to/claude
   ```

compiled binary에서 둘 다 설정되어 있지 않으면, 첫 Claude query 시 Archon이 install instruction과 함께 throw합니다.

Claude Agent SDK는 native compiled binary와 JS `cli.js`를 모두 받을 수 있습니다.

**설치 방법별 일반적인 path:**

| 설치 방법 | 일반적인 executable path |
|---|---|
| Native curl installer (macOS/Linux) | `~/.local/bin/claude` |
| Native PowerShell installer (Windows) | `%USERPROFILE%\.local\bin\claude.exe` |
| Homebrew cask | `$(brew --prefix)/bin/claude` (symlink) |
| npm global install | `$(npm root -g)/@anthropic-ai/claude-code/cli.js` |
| Windows winget | `where claude`로 확인 가능 |
| Docker (`ghcr.io/newturn2017/harnesslab`) | image 안에서 `ENV CLAUDE_BIN_PATH`로 미리 설정됨 — 추가 작업 불필요 |

확실하지 않다면 위 installer 중 하나를 실행한 뒤 macOS/Linux에서는 `which claude`, Windows에서는 `where claude`로 PATH의 실행 파일을 확인하세요.

### 인증 옵션

Claude Code는 `CLAUDE_USE_GLOBAL_AUTH`를 통해 세 가지 authentication mode를 지원합니다.

1. **Global Auth** (`true`로 설정): `claude /login`의 credentials를 사용합니다.
2. **Explicit Tokens** (`false`로 설정): 아래 env vars의 token을 사용합니다.
3. **Auto-Detect** (미설정): env에 token이 있으면 token을, 없으면 global auth를 사용합니다.

### 옵션 1: Global Auth (권장)

```ini
CLAUDE_USE_GLOBAL_AUTH=true
```

### 옵션 2: OAuth Token

```bash
# Install Claude Code CLI first: https://docs.claude.com/claude-code/installation
claude setup-token

# Copy the token starting with sk-ant-oat01-...
```

```ini
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxxxx
```

### 옵션 3: API Key (Pay-per-use)

1. [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)를 방문합니다.
2. 새 key를 만듭니다(`sk-ant-`로 시작).

```ini
CLAUDE_API_KEY=sk-ant-xxxxx
```

### Claude 설정 옵션

`.archon/config.yaml`에서 Claude 동작을 설정할 수 있습니다.

```yaml
assistants:
  claude:
    model: sonnet  # or 'opus', 'haiku', 'claude-*', 'inherit'
    settingSources:
      - project      # Default: only project-level CLAUDE.md
      - user         # Optional: also load ~/.claude/CLAUDE.md
    # Optional: absolute path to the Claude Code executable.
    # Required in compiled HarnessLab binaries if CLAUDE_BIN_PATH is not set.
    # claudeBinaryPath: /absolute/path/to/claude
```

`settingSources` option은 Claude Code SDK가 어떤 `CLAUDE.md` 파일을 load할지 제어합니다. 기본적으로 project-level `CLAUDE.md`만 load됩니다. 개인 `~/.claude/CLAUDE.md`도 load하려면 `user`를 추가하세요.

### 기본값으로 설정 (선택)

codebase context가 없는 새 conversation에서 Claude를 기본 AI assistant로 쓰고 싶다면 다음 environment variable을 설정하세요.

```ini
DEFAULT_AI_ASSISTANT=claude
```

## Codex

Archon은 Codex CLI를 bundle하지 않습니다. Codex CLI를 설치한 뒤 인증하세요.

### Codex CLI 설치

```bash
# Any platform (primary method):
npm install -g @openai/codex

# macOS alternative:
brew install codex

# Windows: npm install works but is experimental.
# OpenAI recommends WSL2 for the best experience.
```

직접 binary를 선호하는 사용자를 위해 native prebuilt binaries(`.dmg`, `.tar.gz`, `.exe`)도 [Codex releases page](https://github.com/openai/codex/releases)에 publish됩니다. compiled binary mode에서는 이를 `~/.archon/vendor/codex/codex`(Windows에서는 `codex.exe`)에 넣으면 Archon이 자동으로 찾습니다.

전체 설치 matrix는 [OpenAI's Codex CLI docs](https://developers.openai.com/codex/cli)를 참고하세요.

### Binary path 설정 (compiled binaries only)

compiled HarnessLab binaries에서 `codex`가 Archon이 기대하는 default PATH에 없다면 다음 중 하나로 path를 제공하세요.

1. **Environment variable** (가장 높은 우선순위):
   ```ini
   CODEX_BIN_PATH=/absolute/path/to/codex
   ```
2. **Config file** (`~/.archon/config.yaml`):
   ```yaml
   assistants:
     codex:
       codexBinaryPath: /absolute/path/to/codex
   ```
3. **Vendor directory** (zero-config fallback): native binary를 `~/.archon/vendor/codex/codex`(Windows에서는 `codex.exe`)에 넣습니다.

Dev mode(`bun run`)에서는 위 설정이 필요 없습니다. SDK가 `node_modules`를 통해 `codex`를 resolve합니다.

### 인증

```bash
codex login

# Follow browser authentication flow
```

### auth file에서 credential 추출

Linux/Mac:
```bash
cat ~/.codex/auth.json
```

Windows:
```cmd
type %USERPROFILE%\.codex\auth.json
```

### environment variable 설정

`.env`에 네 가지 environment variable을 모두 설정합니다.

```ini
CODEX_ID_TOKEN=eyJhbGc...
CODEX_ACCESS_TOKEN=eyJhbGc...
CODEX_REFRESH_TOKEN=rt_...
CODEX_ACCOUNT_ID=6a6a7ba6-...
```

### Codex 설정 옵션

`.archon/config.yaml`에서 Codex 동작을 설정할 수 있습니다.

```yaml
assistants:
  codex:
    model: gpt-5.3-codex
    modelReasoningEffort: medium  # 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
    webSearchMode: live           # 'disabled' | 'cached' | 'live'
    additionalDirectories:
      - /absolute/path/to/other/repo
```

### 기본값으로 설정 (선택)

codebase context가 없는 새 conversation에서 Codex를 기본 AI assistant로 쓰고 싶다면 다음 environment variable을 설정하세요.

```ini
DEFAULT_AI_ASSISTANT=codex
```

## Pi (Community Provider)

**하나의 adapter로 약 20개의 LLM backend를 사용할 수 있습니다.** Pi(`@mariozechner/pi-coding-agent`)는 community-maintained coding-agent harness이며, Archon은 이를 첫 community provider로 통합했습니다. 단일 `provider: pi` entry 아래에서 Anthropic, OpenAI, Google(Gemini + Vertex), Groq, Mistral, Cerebras, xAI, OpenRouter, Hugging Face 등을 사용할 수 있습니다.

Pi는 `builtIn: false`로 등록되어 있습니다. core team이 유지관리하는 option이라기보다 community-provider 경계를 검증하는 역할입니다. 안정성과 가치가 입증되면 나중에 `builtIn: true`로 승격될 수 있습니다.

### 설치

Pi는 `@archon/providers`의 dependency로 포함되어 있으므로 별도 설치가 필요하지 않습니다. 즉시 사용할 수 있습니다.

### 인증

Pi는 OAuth subscription과 API key를 모두 지원합니다. Archon adapter는 `pi` → `/login` 실행으로 생성되는 기존 Pi credentials(`~/.pi/agent/auth.json`)와 env vars를 모두 읽습니다. env vars가 request별로 우선하므로 codebase-scoped override가 가능합니다.

**OAuth subscriptions (`pi /login`을 local에서 실행):**
- Anthropic Claude Pro/Max
- OpenAI ChatGPT Plus/Pro
- GitHub Copilot
- Google Gemini CLI
- Google Antigravity

**API keys (env vars):**

| Pi provider id | Env var |
|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `google` | `GEMINI_API_KEY` |
| `groq` | `GROQ_API_KEY` |
| `mistral` | `MISTRAL_API_KEY` |
| `cerebras` | `CEREBRAS_API_KEY` |
| `xai` | `XAI_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `huggingface` | `HUGGINGFACE_API_KEY` |

추가 Pi backend(Azure, Bedrock, Vertex 등)도 있습니다. 연결이 필요하면 issue를 열어 주세요.

### model reference 형식

Pi model은 `<pi-provider-id>/<model-id>` 형식을 사용합니다.

```yaml
assistants:
  pi:
    model: anthropic/claude-haiku-4-5       # via Anthropic
    # model: google/gemini-2.5-pro           # via Google
    # model: groq/llama-3.3-70b-versatile   # via Groq
    # model: openrouter/qwen/qwen3-coder    # via OpenRouter (nested slashes allowed)
```

### workflow에서 사용

```yaml
name: my-workflow
provider: pi
model: anthropic/claude-haiku-4-5

nodes:
  - id: fast-node
    provider: pi
    model: groq/llama-3.3-70b-versatile   # per-node override — switches backends
    prompt: "..."
    effort: low
    allowed_tools: [read, grep]            # Pi's built-in tools: read, bash, edit, write, grep, find, ls

  - id: careful-node
    provider: pi
    model: anthropic/claude-opus-4-5
    prompt: "..."
    effort: high
    skills: [archon-dev]                   # Archon name refs work — see Pi capabilities below
```

### Pi 기능

| 기능 | 지원 여부 | YAML field |
|---|---|---|
| Session resume | 지원 | automatic(Archon이 `sessionId`를 persist) |
| Tool restrictions | 지원 | `allowed_tools` / `denied_tools` (read, bash, edit, write, grep, find, ls) |
| Thinking level | 지원 | `effort: low\|medium\|high\|max` (max → xhigh) |
| Skills | 지원 | `skills: [name]` (`.agents/skills`, `.claude/skills`, user-global에서 검색) |
| Inline sub-agents | 미지원 | `agents:`는 Claude 전용이며 Pi에서는 warning과 함께 무시됨 |
| System prompt override | 지원 | `systemPrompt:` |
| Codebase env vars (`envInjection`) | 지원 | `.archon/config.yaml` `env:` section |
| MCP servers | 미지원 | Pi는 설계상 MCP를 reject |
| Claude-SDK hooks | 미지원 | Claude-specific format |
| Structured output | 미지원 | Pi backend마다 편차가 있어 v2에서 후속 처리 예정 |
| Cost limits (`maxBudgetUsd`) | 미지원 | result chunk에서 tracking만 하고 enforce하지 않음 |
| Fallback model | 미지원 | Pi native 기능 아님 |
| Sandbox | 미지원 | Pi native 기능 아님 |

지원되지 않는 YAML field는 workflow 실행 시 dag-executor에서 보이는 warning을 발생시킵니다. 그래서 무엇이 무시되었는지 항상 알 수 있습니다.

### 함께 보기

- [Community Provider 추가](../contributing/adding-a-community-provider/) — Archon을 자체 provider로 확장하기 위한 contributor-facing guide입니다.
- [GitHub의 Pi](https://github.com/badlogic/pi-mono) — upstream project입니다.

## assistant 선택 방식

- assistant type은 `.archon/config.yaml`의 `assistant` field 또는 `DEFAULT_AI_ASSISTANT` env var를 통해 codebase별로 설정됩니다.
- conversation이 시작되면 해당 conversation의 assistant type은 고정됩니다.
- `DEFAULT_AI_ASSISTANT`(선택)는 codebase context가 없는 새 conversation에만 사용됩니다.
- workflow는 `provider`와 `model` field로 node별 assistant를 override할 수 있습니다.
- Configuration priority: workflow-level options > config file defaults > SDK defaults 순서입니다.
