---
title: 문제 해결
description: Archon을 로컬 또는 Docker에서 실행할 때 자주 발생하는 문제와 해결책입니다.
category: reference
audience: [user, operator]
status: current
sidebar:
  order: 7
---

HarnessLab 실행 중 자주 발생하는 문제와 해결책입니다.

## Bot이 응답하지 않음

**애플리케이션이 실행 중인지 확인:**

로컬에서 실행 중인 경우:
```bash
# Check the server process
curl http://localhost:3090/health
# Expected: {"status":"ok"}
```

Docker로 실행 중인 경우:
```bash
docker compose ps
# Should show 'app' with state 'Up'
```

**애플리케이션 로그 확인:**

Local:
```bash
# Server logs are printed to stdout when running `bun run dev`
```

Docker:
```bash
docker compose logs -f app
```

**Bot token 확인:**
```bash
# In your .env file
cat .env | grep TELEGRAM_BOT_TOKEN
```

**Health check로 테스트:**
```bash
curl http://localhost:3090/health
# Expected: {"status":"ok"}
```

## Database connection error

**Database health 확인:**
```bash
curl http://localhost:3090/health/db
# Expected: {"status":"ok","database":"connected"}
```

**SQLite(기본값)의 경우:**

SQLite는 별도 설정이 필요 없습니다. Database는 `~/.archon/archon.db`에 자동 생성됩니다. 오류가 보이면 `~/.archon/` directory가 존재하고 writable인지 확인하세요.

**원격 PostgreSQL의 경우:**
```bash
# Verify DATABASE_URL
echo $DATABASE_URL

# Test connection directly
psql $DATABASE_URL -c "SELECT 1"
```

**Table 존재 확인(PostgreSQL):**
```bash
psql $DATABASE_URL -c "\dt"

# Should show: remote_agent_codebases, remote_agent_conversations, remote_agent_sessions,
# remote_agent_isolation_environments, remote_agent_workflow_runs, remote_agent_workflow_events,
# remote_agent_messages
```

## Clone command 실패

**GitHub token 확인:**
```bash
cat .env | grep GH_TOKEN
# Should have both GH_TOKEN and GITHUB_TOKEN set
```

**Token 유효성 테스트:**
```bash
# Test GitHub API access
curl -H "Authorization: token $GH_TOKEN" https://api.github.com/user
```

**Workspace permission 확인:**

Workspace directory는 기본적으로 `~/.archon/workspaces/`입니다(Docker에서는 `/.archon/workspaces/`). 이 directory가 존재하고 writable인지 확인하세요.

**수동 clone 시도:**
```bash
git clone https://github.com/user/repo ~/.archon/workspaces/test-repo
```

## GitHub webhook이 트리거되지 않음

**Webhook delivery 확인:**
1. GitHub의 webhook setting으로 이동
2. Webhook 클릭
3. "Recent Deliveries" tab 확인
4. 성공 delivery(green checkmark) 확인

**Webhook secret 확인:**
```bash
cat .env | grep WEBHOOK_SECRET
# Must match exactly what you entered in GitHub
```

**ngrok 실행 확인(local dev):**
```bash
# Check ngrok status
curl http://localhost:4040/api/tunnels
# Or visit http://localhost:4040 in browser
```

**Webhook processing 관련 application log 확인:**

Local:
```bash
# Look for GitHub-related log lines in server output
```

Docker:
```bash
docker compose logs -f app | grep GitHub
```

## Port conflict

**Port 3090이 이미 사용 중인지 확인:**

macOS/Linux:
```bash
lsof -i :3090
```

Windows:
```bash
netstat -ano | findstr :3090
```

`PORT` 환경 변수로 port를 override할 수 있습니다.
```bash
PORT=4000 bun run dev
```

Git worktree에서 실행하면 Archon이 unique port(range 3190-4089)를 자동 할당하므로 main instance와 충돌을 걱정할 필요가 없습니다.

### Stale process(Windows)

**증상:** Web UI에 spinner만 보이고 응답이 없으며, `bun run dev`를 시작했는데도 terminal에 활동이 없습니다.

**원인:** 이전 `bun` 또는 `node` process가 여전히 port를 잡고 있습니다. Windows에서 server를 중지하지 않고 terminal을 닫을 때 흔합니다.

**진단:**

```powershell
netstat -ano | findstr :3090
```

마지막 column의 PID를 확인한 뒤 어떤 process인지 확인합니다.

```powershell
tasklist | findstr 12345
```

(`12345`를 실제 PID로 바꾸세요.)

**수정 - PID로 종료**(권장):

```powershell
taskkill /F /PID 12345
```

Stale process가 여러 개 있으면:

```powershell
taskkill /F /IM bun.exe
taskkill /F /IM node.exe
```

:::caution
`claude.exe` process는 종료하지 마세요. 이는 active Claude Code session입니다.
:::

Windows별 추가 지침은 [Windows Setup](/deployment/windows/)도 참고하세요.

## E2E Testing / agent-browser

**`agent-browser: command not found`:**

`agent-browser`는 optional external dependency입니다. 설치는 [E2E Testing Guide](/deployment/e2e-testing/)를 참고하세요.

```bash
npm install -g agent-browser
agent-browser install
```

**agent-browser daemon fails to start(Windows):**

agent-browser에는 [known Windows bug](https://github.com/vercel-labs/agent-browser/issues/56)가 있습니다. WSL을 workaround로 사용하세요. [E2E Testing on WSL](/deployment/e2e-testing-wsl/)을 참고하세요.

**agent-browser daemon fails to start(macOS/Linux):**

Stale daemon을 종료하고 다시 시도합니다.
```bash
pkill -f daemon.js
agent-browser open http://localhost:3090
```

## Docker

다음 문제들은 Docker container 안에서 Archon을 실행할 때 해당합니다.

### Container가 시작되지 않음

**구체적 error를 logs에서 확인:**
```bash
docker compose logs app
```

**환경 변수 확인:**
```bash
# Check if .env is properly formatted
docker compose config
```

**Cache 없이 rebuild:**
```bash
docker compose build --no-cache
docker compose up -d
```

`with-db` profile을 사용한다면 위 command에 `--profile with-db`를 추가하세요.

### Docker database 문제

**로컬 PostgreSQL(`with-db` profile)의 경우:**
```bash
# Check if postgres container is running
docker compose --profile with-db ps postgres

# Check postgres logs
docker compose logs -f postgres

# Test direct connection
docker compose exec postgres psql -U postgres -c "SELECT 1"
```

**Table 존재 확인(Docker PostgreSQL):**
```bash
docker compose exec postgres psql -U postgres -d remote_coding_agent -c "\dt"

# Should show: remote_agent_codebases, remote_agent_conversations, remote_agent_sessions,
# remote_agent_isolation_environments, remote_agent_workflow_runs, remote_agent_workflow_events,
# remote_agent_messages
```

### Docker clone 문제

**Container 내부 workspace permission 확인:**
```bash
docker compose exec app ls -la /.archon/workspaces
```

**Container 내부에서 수동 clone 시도:**
```bash
docker compose exec app git clone https://github.com/user/repo /.archon/workspaces/test-repo
```

## Compiled binary 실행 시 "Claude Code not found"

**증상:** Claude를 사용하는 workflow가 다음 오류로 실패합니다.

```
Claude Code not found. HarnessLab requires the Claude Code executable to be
reachable at a configured path in compiled builds.
```

**원인:** Compiled HarnessLab binary(curl/PowerShell installer 또는 Homebrew의 `archon`)에는 Claude Code가 bundle되어 있지 않습니다. Claude Code executable에 대한 명시적 path가 필요합니다. Source/dev mode(`bun run`)는 `node_modules`를 통해 auto-resolve되며 영향을 받지 않습니다.

**수정:** Claude Code를 별도로 설치하고 Archon이 해당 경로를 보게 합니다.

```bash
# macOS / Linux / WSL — Anthropic's recommended native installer
curl -fsSL https://claude.ai/install.sh | bash
export CLAUDE_BIN_PATH="$HOME/.local/bin/claude"

# Windows (PowerShell)
irm https://claude.ai/install.ps1 | iex
$env:CLAUDE_BIN_PATH = "$env:USERPROFILE\.local\bin\claude.exe"
```

영구 설정은 대신 `~/.archon/config.yaml`에 path를 설정하세요.

```yaml
assistants:
  claude:
    claudeBinaryPath: /absolute/path/to/claude
```

`archon setup`은 `CLAUDE_BIN_PATH`를 자동 감지하고 써 줍니다. Docker 사용자는 아무것도 할 필요가 없습니다. Image가 variable을 미리 설정합니다.

전체 install matrix는 [AI Assistants → Binary path configuration](/getting-started/ai-assistants/#binary-path-configuration-compiled-binaries-only) guide를 참고하세요.

## Claude Code 안에서 workflow 실행 시 조용히 멈춤

**증상:** Claude Code session 내부(예: Terminal tool)에서 시작한 workflow가 output을 내지 않거나, CLI가 workflow hang 전에 `CLAUDECODE=1` 관련 warning을 출력합니다.

**원인:** Nested Claude Code session은 deadlock될 수 있습니다. 바깥 session은 tool result를 기다리지만 안쪽 session은 이를 전달하지 못합니다.

**수정:** Claude Code 밖의 일반 shell에서 `archon serve`를 실행하고 Web UI 또는 HTTP API를 사용하세요.

**Warning 숨기기:** Deadlock이 발생하지 않는 setup이고 warning만 숨기고 싶다면:

```bash
ARCHON_SUPPRESS_NESTED_CLAUDE_WARNING=1 archon workflow run ...
```

**Timeout 조정:** 환경이 느려 60초 first-event timeout에 걸린다면:

```bash
ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS=120000 archon workflow run ...
```

## Worktree가 다른 clone에 속함

**증상:** 한 local clone에서 workflow를 실행할 때(특히 `--branch <name>` 사용) 다음 오류 중 하나가 표시됩니다.

- `Worktree at <path> belongs to a different clone (<other-clone-path>). Remove it from that clone or use a different codebase registration.`
- `Cannot verify worktree ownership at <path>: <reason>`
- `Cannot adopt <path>: path contains a full git checkout, not a worktree.`
- `Cannot adopt <path>: .git pointer is not a git-worktree reference.`

**원인:** Archon은 remote URL(`owner/repo`)에서 codebase identity를 도출하므로 같은 remote의 두 local clone은 하나의 `codebase_id`를 공유합니다. Worktree는 shared path(`~/.archon/workspaces/<owner>/<repo>/worktrees/`) 아래 저장되기 때문에 clone A가 만든 worktree가 clone B에서도 disk에 보입니다. Isolation system은 잘못된 filesystem state에서 작업하지 않도록 clone 간 silent adoption을 거부합니다.

**수정 - 하나를 선택하세요:**

1. **다른 clone의 worktree 제거.** 다른 clone의 in-progress 작업이 더 이상 필요 없다면:

   ```bash
   # From the other clone's directory, find and remove the conflicting worktree
   archon isolation list
   archon complete <branch-name>          # graceful cleanup
   # or, if no work to preserve:
   git worktree remove <path> --force
   ```

2. **다른 branch name 사용.** 두 clone이 같은 worktree path를 두고 경쟁하지 않도록 이번 run에 다른 branch name을 사용합니다.

   ```bash
   archon workflow run <name> --branch <different-name> "task"
   ```

3. **하나의 clone에서 작업.** 두 local checkout이 같은 project라면 하나로 통합하세요. HarnessLab의 codebase registration은 현재 remote당 하나의 local path를 가정합니다. 진짜 multi-clone support는 [#1192](https://github.com/coleam00/Archon/issues/1192)에서 추적 중입니다.

**다른 변형:**

- `path contains a full git checkout, not a worktree`: Archon이 아닌 다른 무언가가 worktree path에 full git repo를 만들었습니다. 제거하거나 이동하세요.
- `.git pointer is not a git-worktree reference`: 해당 path의 `.git` file이 예상 밖의 위치(submodule, malformed)를 가리킵니다. `cat <path>/.git`으로 확인하고 수동 정리하세요.
- `Cannot verify worktree ownership`: `<path>/.git` 읽기 중 filesystem permission 또는 I/O error입니다. `ls -la <path>`와 `~/.archon/workspaces`의 file permission을 확인하세요.
