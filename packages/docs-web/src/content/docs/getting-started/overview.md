---
title: 시작하기
description: 아무것도 없는 상태에서 동작하는 HarnessLab 설정까지 필요한 모든 것.
category: getting-started
audience: [user]
status: current
sidebar:
  order: 0
---

아무것도 없는 상태에서 동작하는 HarnessLab 설정까지 필요한 모든 것을 다룹니다. Web UI를 선호하든 CLI를 선호하든 이 문서에서 시작할 수 있습니다.

HarnessLab은 Archon fork를 바탕으로 반복 가능한 AI coding workflow harness와 학습 가능한 에이전트 워크플로를 실험하기 위한 문서 사이트입니다. 내부 명령, 패키지명, CLI 이름은 upstream 호환성을 위해 Archon 이름을 그대로 사용합니다.

---

## 사전 준비

시작하기 전에 다음이 준비되어 있는지 확인하세요.

| 요구 사항 | 확인 방법 | 설치 방법 |
| -------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| **Git** | `git --version` | [git-scm.com](https://git-scm.com/) |
| **Bun** (Node.js + npm 대체) | `bun --version` | Linux/macOS: `curl -fsSL https://bun.sh/install \| bash` — Windows: `powershell -c "irm bun.sh/install.ps1 \| iex"` |
| **Claude Code CLI** | `claude --version` | [docs.claude.com/claude-code/installation](https://docs.claude.com/en/docs/claude-code/installation) — compiled HarnessLab binaries에서는 `CLAUDE_BIN_PATH`도 설정하세요([자세히 보기](/getting-started/ai-assistants/#binary-path-configuration-compiled-binaries-only)) |
| **GitHub account** | — | [github.com](https://github.com/) |

> **root로 실행하지 마세요.** Archon과 Archon이 의존하는 Claude Code CLI는 `root` 사용자로 실행할 때 동작하지 않습니다. VPS나 서버에 root만 있다면 먼저 일반 사용자를 만드세요.
>
> ```bash
> adduser archon          # create user (Debian/Ubuntu)
> usermod -aG sudo archon # give sudo access
> su - archon             # switch to the new user
> ```
>
> 그런 다음 새 사용자 세션 안에서 이 가이드를 이어가세요.

> **Windows 사용자:** Archon은 Windows에서 네이티브로 실행됩니다. WSL2는 필요하지 않습니다. Git Bash가 포함된 [Git for Windows](https://git-scm.com/)와 [Bun for Windows](https://bun.sh/docs/installation#windows)를 설치하세요. 한 가지 주의할 점은 DAG workflow의 `bash:` 노드에는 bash 실행 파일이 필요하다는 것입니다. Git Bash가 이를 자동으로 제공합니다.

> **Bun은 Node.js를 대체합니다.** Node.js나 npm을 별도로 설치할 필요가 없습니다. 이 프로젝트에서 Bun은 런타임, 패키지 매니저, 테스트 러너 역할을 모두 합니다. 이미 Node.js가 있어도 괜찮지만 Archon은 사용하지 않습니다.

---

## 1단계: clone 및 설치

먼저 HarnessLab 서버 코드를 둘 위치를 선택합니다.

**옵션 A: Home directory** (개인 사용, 단일 사용자)

Linux/macOS:

```bash
cd ~  # or your preferred directory
git clone https://github.com/NewTurn2017/HarnessLab
cd HarnessLab
```

Windows (PowerShell):

```powershell
cd $HOME  # or your preferred directory
git clone https://github.com/NewTurn2017/HarnessLab
cd HarnessLab
```

**옵션 B: /opt** (Linux/macOS 서버 설치 — 디렉터리를 깔끔하게 유지)

```bash
sudo mkdir -p /opt/harnesslab
sudo chown $USER:$USER /opt/harnesslab
git clone https://github.com/NewTurn2017/HarnessLab /opt/harnesslab
cd /opt/harnesslab
```

그런 다음 의존성을 설치합니다.

```bash
bun install
```

monorepo 전체의 의존성이 설치됩니다. 보통 약 30초가 걸립니다.

---

## 2단계: 인증 설정

GitHub token(저장소 clone용)과 Claude authentication(AI assistant용) 두 가지가 필요합니다.

### GitHub Token

1. [github.com/settings/tokens](https://github.com/settings/tokens)로 이동합니다.
2. **"Generate new token (classic)"**을 클릭합니다.
3. scope로 **`repo`**를 선택합니다.
4. token을 복사합니다(`ghp_...`로 시작).

### Claude 인증

이미 Claude Code를 사용하고 있다면 대부분 인증이 끝난 상태입니다. 다음으로 확인하세요.

```bash
claude --version
```

인증되어 있지 않다면:

```bash
claude /login
```

브라우저 흐름을 따라 로그인하세요. 자격 증명은 전역으로 저장되므로 API key가 필요하지 않습니다.

---

## 3단계: .env 파일 만들기

> **Web UI / server mode에서는 필수, CLI-only 사용에서는 선택 사항입니다.** CLI는 기본적으로 기존 Claude authentication을 사용합니다.

```bash
cp .env.example .env
```

에디터에서 `.env`를 열고 다음 두 값을 설정합니다.

```ini
# Paste your GitHub token in both (they serve different parts of the system)
GH_TOKEN=ghp_your_token_here
GITHUB_TOKEN=ghp_your_token_here

# Use your existing Claude Code login
CLAUDE_USE_GLOBAL_AUTH=true
```

여기까지면 충분합니다. 나머지는 합리적인 기본값이 있습니다.

- **Database:** `~/.archon/archon.db`의 SQLite(자동 생성, 추가 설정 없음)
- **Port:** API server는 3090, Web UI dev server는 5173
- **AI assistant:** Claude(기본값)

> **GitHub token 변수가 왜 두 개인가요?** `GH_TOKEN`은 GitHub CLI(`gh`)가 사용하고, `GITHUB_TOKEN`은 Archon의 GitHub adapter가 사용합니다. 둘 다 같은 값으로 설정하세요.

---

## 실행 방식 선택

### 경로 A: Web UI (Server)

**4단계: server 시작**

```bash
bun run dev
```

이 명령은 두 가지를 동시에 시작합니다.

- **Backend API server**: `http://localhost:3090`
- **Web UI**: `http://localhost:5173`

다음과 비슷한 출력이 보여야 합니다.

```
[server] Hono server listening on port 3090
[web] VITE ready in Xms
[web] Local: http://localhost:5173/
```

> **Homelab / remote server인가요?** backend API는 기본적으로 이미 `0.0.0.0`에 bind되므로 다른 머신에서 접근할 수 있습니다. 하지만 Vite dev server(Web UI)는 `localhost`에서만 listen합니다. 네트워크에서 Web UI를 노출하려면:
>
> ```bash
> bun run dev:web -- --host 0.0.0.0
> ```
>
> 그런 다음 `bun run dev:server`로 backend를 별도로 시작하세요. Web UI는 `http://<server-ip>:5173`에서 접근할 수 있습니다. 방화벽에서 `5173`과 `3090` 포트를 허용했는지 확인하세요.

**5단계: 동작 확인**

브라우저에서 **http://localhost:5173**을 엽니다. HarnessLab Web UI가 보여야 합니다.

**빠른 검증 체크리스트:**

1. **Health check** — 새 터미널에서:

   ```bash
   curl http://localhost:3090/health
   # Expected: {"status":"ok"}
   ```

2. **Database check:**

   ```bash
   curl http://localhost:3090/health/db
   # Expected: {"status":"ok","database":"connected"}
   ```

3. **테스트 메시지 보내기** — Web UI에서 새 conversation을 만들고 다음을 입력합니다.
   ```
   /status
   ```
   platform type과 session info가 포함된 status response가 보여야 합니다.

세 가지가 모두 동작하면 실행 준비가 끝난 것입니다.

**6단계: repository clone 후 coding 시작**

Web UI chat에서 작업할 repo를 clone합니다.

```
/clone https://github.com/user/your-repo
```

그다음 AI에게 자연어로 말하면 됩니다.

```
What's the structure of this repo?
```

AI가 codebase를 분석하고 응답합니다. workflow도 사용할 수 있습니다.

```
/workflow list
```

사용 가능한 모든 workflow가 표시됩니다. 하나를 시도해 보세요.

```
Help me understand the authentication module
```

AI router가 메시지에 맞는 workflow를 자동으로 선택합니다.

---

### 경로 B: CLI (No Server)

**4단계: CLI를 전역 설치**

```bash
cd packages/cli && bun link && cd ../..
```

이 명령은 어느 repository에서나 실행할 수 있도록 `archon` 명령을 전역 등록합니다.

`Success! Registered "@archon/cli"` 출력 뒤에 `bun link @archon/cli`에 관한 메시지가 보일 수 있습니다. **그 두 번째 부분은 무시하세요.** 다른 프로젝트에서 Archon을 dependency로 추가할 때 쓰는 안내입니다.

Bun은 linked binary를 `~/.bun/bin/`에 설치합니다. `archon` 명령을 찾을 수 없다면 아직 그 디렉터리가 `PATH`에 없는 것입니다. 다음처럼 고치세요.

```bash
# Add to your shell profile (~/.bashrc, ~/.zshrc, etc.)
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

동작을 확인합니다.

```bash
archon version
```

**5단계: repository에서 workflow 실행**

```bash
cd /path/to/your/repository

# See available workflows
archon workflow list

# Ask a question about the codebase
archon workflow run archon-assist "How does the auth module work?"

# Plan a feature on an isolated branch
archon workflow run archon-feature-development --branch feat/dark-mode "Add dark mode"

# Fix a GitHub issue
archon workflow run archon-fix-github-issue --branch fix/issue-42 "Fix issue #42"
```

여기까지입니다. CLI는 git repo를 자동 감지하고, 상태 추적에는 SQLite(`~/.archon/archon.db`)를 사용하며, 출력은 stdout으로 streaming합니다.

> **대상 디렉터리는 git repository여야 합니다.** Archon은 격리를 위해 git worktree를 사용하므로 `.git` 폴더가 필요합니다. 프로젝트가 아직 git repo가 아니라면 먼저 `git init && git add . && git commit -m "initial commit"`을 실행하세요.

---

## CLI 참고 자료

### workflow 실행 예

```bash
# List all available workflows
archon workflow list

# Run a workflow
archon workflow run <name> "<message>"

# Run with worktree isolation (recommended for code changes)
archon workflow run <name> --branch <branch-name> "<message>"

# Run directly in the live checkout without worktree isolation
archon workflow run <name> --no-worktree "<message>"

# Run against a different directory
archon workflow run <name> --cwd /path/to/repo "<message>"
```

### CLI 명령

| Command | 기능 |
|---------|-------------|
| `archon chat <message>` | orchestrator에 message를 보냅니다 |
| `archon setup` | credentials와 config를 위한 interactive setup wizard를 실행합니다 |
| `archon workflow list` | 사용 가능한 workflow 목록을 표시합니다 |
| `archon workflow run <name> [msg]` | workflow를 실행합니다 |
| `archon workflow status` | 실행 중인 workflow를 표시합니다 |
| `archon workflow resume <id>` | 실패한 workflow를 재개합니다 |
| `archon workflow abandon <id>` | terminal 상태가 아닌 run을 abandon합니다 |
| `archon workflow approve <id> [comment]` | interactive loop gate를 승인합니다 |
| `archon workflow reject <id> [--reason "..."]` | approval gate를 거절합니다 |
| `archon workflow cleanup [days]` | 오래된 run record를 삭제합니다(기본: 7일) |
| `archon workflow event emit` | workflow event를 emit합니다 |
| `archon isolation list` | active worktree 목록을 표시합니다 |
| `archon isolation cleanup [days]` | stale environment를 제거합니다 |
| `archon isolation cleanup --merged` | merge된 branch를 제거합니다 |
| `archon isolation cleanup --merged --include-closed` | closed(abandoned) PR branch도 함께 제거합니다 |
| `archon complete <branch>` | branch lifecycle을 완료합니다 |
| `archon validate workflows [name]` | workflow definition을 검증합니다 |
| `archon validate commands [name]` | command file을 검증합니다 |
| `archon version` | version info를 표시합니다 |

### Worktree 관리

```bash
archon isolation list              # show active worktrees
archon isolation cleanup           # remove stale (>7 days)
archon isolation cleanup 14        # custom staleness threshold
archon isolation cleanup --merged            # remove merged branches (deletes remote too)
archon isolation cleanup --merged --include-closed  # also remove closed/abandoned PR branches
archon complete <branch>           # complete branch lifecycle (worktree + branches)
archon complete <branch> --force   # skip uncommitted-changes check
```

<a id="available-workflows"></a>

### 사용 가능한 Workflows

| Workflow | 기능 |
|----------|-------------|
| `archon-assist` | 일반 Q&A, debugging, 탐색, CI failure 등을 처리하는 범용 workflow |
| `archon-fix-github-issue` | 조사, root cause analysis, fix 구현, validation, PR 생성 |
| `archon-idea-to-pr` | feature idea를 plan, implement, validate하고 PR과 parallel review, self-fix까지 수행 |
| `archon-plan-to-pr` | 기존 plan을 실행하고 implement, validate, PR, review까지 진행 |
| `archon-feature-development` | plan에서 feature를 구현하고 validate한 뒤 PR 생성 |
| `archon-comprehensive-pr-review` | automatic fix를 포함한 multi-agent PR review(5개 parallel reviewer) |
| `archon-smart-pr-review` | 복잡도에 맞춰 관련 agent만 route하는 PR review |
| `archon-create-issue` | 문제를 classify하고 context 수집, investigate 후 GitHub issue 생성 |
| `archon-validate-pr` | main과 feature branch 양쪽을 테스트하는 철저한 PR validation |
| `archon-resolve-conflicts` | PR의 merge conflict를 detect, analyze, resolve |
| `archon-refactor-safely` | type-check hook과 behavior verification을 포함한 안전한 refactoring |
| `archon-architect` | architecture sweep, complexity reduction, codebase health 점검 |
| `archon-ralph-dag` | PRD implementation loop(story가 끝날 때까지 반복) |
| `archon-issue-review-full` | GitHub issue를 위한 comprehensive fix와 full multi-agent review |
| `archon-test-loop-dag` | 모든 test가 통과할 때까지 반복하는 test-fix cycle |
| `archon-remotion-generate` | AI로 Remotion video composition 생성 또는 수정 |
| `archon-interactive-prd` | guided conversation을 통해 PRD 생성 |
| `archon-piv-loop` | human-in-the-loop 방식의 guided Plan-Implement-Validate development |
| `archon-adversarial-dev` | adversarial development로 완전한 application을 처음부터 구축 |

이 bundled workflow들은 대부분의 프로젝트에서 바로 사용할 수 있습니다. 커스터마이즈하려면 `.archon/workflows/defaults/`에서 하나를 `.archon/workflows/`로 복사해 수정하세요. 같은 이름의 파일은 기본값을 override합니다.

> **Auto-selection:** workflow 이름을 외울 필요가 없습니다. 원하는 일을 설명하기만 하면 router가 모든 workflow description을 읽고 가장 적합한 것을 선택합니다. 예를 들어 "fix issue #42"는 `archon-fix-github-issue`로 route되고, "review this PR"은 `archon-smart-pr-review`로 route됩니다. 명확히 맞는 것이 없으면 `archon-assist`로 fallback합니다.

---

## 대상 repo 커스터마이즈

대상 repo에 `.archon/` 디렉터리를 추가해 repo-specific 동작을 정의할 수 있습니다.

```
your-repo/
└── .archon/
    ├── config.yaml         # AI assistant, worktree copy rules
    ├── commands/            # Custom commands (.md files)
    └── workflows/           # Custom multi-step workflows (.yaml files)
```

**Example `.archon/config.yaml`:**

```yaml
assistant: claude
commands:
  folder: .claude/commands/archon    # additional command search path
worktree:
  copyFiles:
    - .env.example                   # copy into worktrees (same filename)
    - .env
```

`.archon/` config가 없어도 platform은 합리적인 기본값(bundled commands와 workflows)을 사용합니다.

### custom command

repo의 `.archon/commands/`에 `.md` 파일을 두세요.

```markdown
---
description: Run the full test suite
argument-hint: <module>
---

# Test Runner

Run tests for: $ARGUMENTS
```

사용 가능한 변수: `$1`, `$2`, `$3`(positional), `$ARGUMENTS`(전체 args), `$ARTIFACTS_DIR`(workflow artifacts directory), `$WORKFLOW_ID`(run ID), `$BASE_BRANCH`(base branch), `$nodeId.output`(DAG node output).

### custom workflow

repo의 `.archon/workflows/`에 `.yaml` 파일을 두세요.

```yaml
name: my-workflow
description: Plan then implement a feature
model: sonnet

nodes:
  - id: plan
    command: plan

  - id: implement
    command: implement
    depends_on: [plan]
    context: fresh
```

workflow는 여러 command를 DAG node로 연결하고, parallel execution과 conditional branching을 지원하며, `$nodeId.output` substitution으로 node 간 context를 전달합니다.

> **commands와 workflows는 어디에서 load되나요?**
>
> commands와 workflows는 runtime에 현재 working directory에서 load됩니다. 고정된 global location에서 load되지 않습니다.
>
> - **CLI:** `archon` 명령을 실행한 위치에서 읽습니다. local repo에서 실행하면 uncommitted change도 즉시 반영됩니다.
> - **Server (Telegram/Slack/GitHub):** `~/.archon/workspaces/owner/repo/`의 workspace clone에서 읽습니다. 이 clone은 worktree 생성 전에만 remote에서 sync되므로 server가 변경 사항을 보려면 **commit and push**가 필요합니다.
>
> 요약하면 CLI는 local files를 보고, server는 push된 내용을 봅니다.

---

## 격리 (Worktrees)

`--branch` flag를 사용하면 CLI가 git worktree를 만들어 격리된 디렉터리에서 작업합니다. 이렇게 하면 parallel task끼리 또는 main branch와 충돌하지 않습니다.

```
~/.archon/
├── archon.db              # SQLite database (auto-created)
└── workspaces/            # Project-centric layout
    └── owner/repo/
        ├── source/        # Clone or symlink to local path
        ├── worktrees/     # Isolated working copies per task
        │   ├── fix/issue-42/
        │   └── feat/dark-mode/
        ├── artifacts/     # Workflow artifacts (never in git)
        └── logs/          # Workflow execution logs
```

---

## Claude Code와 함께 사용하기 (Skill)

Claude Code가 대신 HarnessLab workflow를 호출할 수 있게 하려면 프로젝트에 HarnessLab skill을 설치하세요. setup wizard가 이를 자동으로 처리합니다. `archon setup`을 실행하고 skill installation prompt를 승인하면 됩니다.

수동으로 설치하려면:

```bash
cp -r HarnessLab/.claude/skills/archon /path/to/your/repo/.claude/skills/
```

그런 다음 Claude Code에서 "use archon to fix issue #42"처럼 말하면 적절한 workflow를 호출합니다.

---

## 전체 platform 실행 (Server + Chat Adapters)

CLI는 standalone으로 동작하지만 Telegram, Slack, Discord, GitHub webhooks로도 상호작용하고 싶다면 [README Server Setup](https://github.com/NewTurn2017/HarnessLab#quickstart)을 보거나, HarnessLab repo에서 Claude Code를 열고 "set up archon"이라고 말해 setup wizard를 실행하세요.

---

## 문제 해결

### "Cannot create worktree: not in a git repository" (but the repo exists)

실제 원인은 보통 이전 HarnessLab run에서 다른 path를 사용해 생긴 stale symlink입니다. error output에서 다음 내용을 찾아보세요.

```
Source symlink at ~/.archon/workspaces/.../source already points to <old-path>, expected <new-path>
```

`~/.archon/workspaces/<github-user>/<repo-name>`의 stale workspace folder를 수동으로 삭제한 뒤 명령을 다시 실행하면 해결됩니다.

> 앞으로는 `archon isolation cleanup`이 이를 자동으로 처리할 예정입니다.

---

### "command not found: bun"

Bun을 설치하세요: `curl -fsSL https://bun.sh/install | bash`. 그런 다음 터미널을 재시작하거나 `source ~/.bashrc`를 실행하세요.

### "command not found: claude"

Claude Code CLI를 설치하세요. [docs.claude.com/claude-code/installation](https://docs.claude.com/en/docs/claude-code/installation)을 참고하세요.

### Port 3090 already in use

다른 프로세스가 포트를 사용 중입니다. 해당 프로세스를 중지하거나 port를 override하세요.

```bash
PORT=4000 bun run dev
```

### Web UI shows "disconnected"

backend가 실행 중인지 확인하세요(`bun run dev`는 backend와 frontend를 모두 시작합니다). terminal에서 error를 확인하고, browser를 새로고침해 보세요.

### Clone command fails with 401/403

GitHub token이 없거나 유효하지 않습니다. 다음을 확인하세요.

```bash
# Test your token
curl -H "Authorization: token $(grep GH_TOKEN .env | cut -d= -f2)" https://api.github.com/user
```

GitHub profile이 반환되면 token이 동작하는 것입니다. 아니라면 새로 발급하세요.

### AI doesn't respond

Claude authentication이 동작하는지 확인하세요.

```bash
claude --version   # Should show version
claude /login      # Re-authenticate if needed
```

### "Cannot find module" or dependency errors

```bash
bun install
```

그래도 해결되지 않으면 `node_modules` 폴더를 삭제한 뒤 다시 설치하세요.

```bash
bun install
```

---

## 빠른 참고표

| 작업 | 명령 |
| ------------------- | ----------------------------------- |
| 전체 시작 | `bun run dev` |
| backend만 시작 | `bun run dev:server` |
| frontend만 시작 | `bun run dev:web` |
| test 실행 | `bun run test` |
| type check | `bun run type-check` |
| 전체 validation | `bun run validate` |
| Web UI | http://localhost:5173 |
| API server | http://localhost:3090 |
| Health check | `curl http://localhost:3090/health` |

---

## 다음 단계

### chat platform 추가 (선택)

휴대폰에서 Archon에 message를 보내고 싶다면 다음 중 하나를 선택하세요.

| Platform | 난이도 | Guide |
| ------------------- | --------------- | --------------------------------------------------------------------- |
| **Telegram** | 쉬움(5분) | [adapter 설정](/adapters/telegram/) |
| **Discord** | 쉬움(5분) | [adapter 설정](/adapters/community/discord/) |
| **Slack** | 중간(15분) | [adapter 설정](/adapters/slack/) |
| **GitHub Webhooks** | 중간(15분) | [adapter 설정](/adapters/github/) |

### custom command와 workflow 만들기

Archon이 실행할 수 있는 AI prompt를 repo에 추가하세요.

```
your-repo/
└── .archon/
    ├── commands/        # Markdown files with AI instructions
    └── workflows/       # YAML files chaining commands together
```

[workflow 작성](/guides/authoring-workflows/)과 [command 작성](/guides/authoring-commands/)을 참고하세요.

### server에 배포

어느 device에서나 항상 접근하려면 [Docker 배포 가이드](/deployment/docker/)를 참고하세요.

---

## 더 읽을거리

- [설정](/getting-started/configuration/) — 모든 configuration option
- [AI 어시스턴트](/getting-started/ai-assistants/) — Claude와 Codex setup 상세
- [CLI 참고 자료](/reference/cli/) — 전체 CLI documentation
- [workflow 작성](/guides/authoring-workflows/) — custom workflow 만들기
