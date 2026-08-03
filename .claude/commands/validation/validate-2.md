# Ultimate Validation Command (Updated January 2026)

Run comprehensive end-to-end validation of the Remote Agentic Coding Platform including Docker, Test Adapter, Database, and **full GitHub workflow execution**.

**The key test (Phase 8):** Creates a GitHub issue, then invokes the full workflow via issue comments:
1. `@Archon /command-invoke prime` - Analyze codebase
2. `@Archon /command-invoke plan-feature` - Create implementation plan
3. `@Archon /command-invoke execute` - Implement changes and create PR
4. (Phase 9) `@Archon /command-invoke review-pr` - Review the created PR

**Usage:**
```bash
/validation:validate-2 <ngrok-url>
```

**Example:**
```bash
/validation:validate-2 https://trinity-nonadverbial-enharmonically.ngrok-free.dev
```

**Prerequisites:**
- ngrok running and exposing port 3090 (for GitHub webhooks)
- `.env` file configured with all required credentials
- GitHub CLI (`gh`) authenticated
- Docker installed and running

**Updated for:**
- Bun runtime (not npm)
- Archon paths (`~/.archon/workspaces/owner/repo`)
- 6 database tables (codebases, conversations, sessions, command_templates, isolation_environments, workflow_runs)
- Worktree isolation with database tracking
- Full GitHub workflow: Issue → Prime → Plan → Execute → PR → Review
- Comprehensive command testing (/help, /clone, /repos, /templates, /status, /getcwd, /setcwd, /init, /reset, /worktree cleanup, /worktree orphans)
- PR/Issue worktree sharing verification
- GitHub close event cleanup trigger
- Database consistency checks (orphaned records)

---

## Phase 1: Foundation Validation

### 1.1 Type Checking
```bash
bun run type-check
```
**Expected:** Zero TypeScript errors

### 1.2 Linting
```bash
bun run lint
```
**Expected:** Zero ESLint errors (warnings acceptable)

### 1.3 Code Formatting
```bash
bun run format:check
```
**Expected:** All files pass Prettier checks

### 1.4 Unit Tests
```bash
bun test
```
**Expected:** All critical tests pass

### 1.5 Build
```bash
bun run build
```
**Expected:** Clean build to `dist/` directory

**If any step fails, STOP and report the issue immediately.**

---

## Phase 2: Environment Setup

### 2.0 Initialize Variables and Clean Workspace
```bash
# Load environment variables
source .env

# Store project root directory
PROJECT_ROOT="$(pwd)"
export PROJECT_ROOT

# Determine workspace path
if [ -n "$ARCHON_HOME" ]; then
  WORK_DIR="${ARCHON_HOME}/workspaces"
else
  WORK_DIR="${HOME}/.archon/workspaces"
fi

echo "Project root: ${PROJECT_ROOT}"
echo "Workspace directory: ${WORK_DIR}"

# Remove previous test repositories
rm -rf "${WORK_DIR}"/remote-coding-test-*
rm -rf "${HOME}/.archon/worktrees"/remote-coding-test-*

# Clean up test conversations from database
if command -v psql &> /dev/null; then
  echo "Cleaning database with psql..."
  psql "$DATABASE_URL" -c "DELETE FROM remote_agent_sessions WHERE conversation_id IN (SELECT id FROM remote_agent_conversations WHERE platform_conversation_id LIKE 'test-%');" 2>&1
  psql "$DATABASE_URL" -c "DELETE FROM remote_agent_isolation_environments WHERE workflow_id LIKE '%test%' OR workflow_id LIKE '%remote-coding-test%';" 2>&1
  psql "$DATABASE_URL" -c "DELETE FROM remote_agent_workflow_runs WHERE conversation_id IN (SELECT id FROM remote_agent_conversations WHERE platform_conversation_id LIKE 'test-%');" 2>&1
  psql "$DATABASE_URL" -c "DELETE FROM remote_agent_conversations WHERE platform_conversation_id LIKE 'test-%';" 2>&1
  psql "$DATABASE_URL" -c "DELETE FROM remote_agent_codebases WHERE name LIKE 'remote-coding-test-%';" 2>&1
  echo "Database cleaned"
else
  echo "psql not found, using bun for cleanup..."
  bun -e "
    const { Client } = require('pg');
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    async function cleanup() {
      await client.connect();
      await client.query(\"DELETE FROM remote_agent_sessions WHERE conversation_id IN (SELECT id FROM remote_agent_conversations WHERE platform_conversation_id LIKE 'test-%')\");
      await client.query(\"DELETE FROM remote_agent_isolation_environments WHERE workflow_id LIKE '%test%'\");
      await client.query(\"DELETE FROM remote_agent_workflow_runs WHERE conversation_id IN (SELECT id FROM remote_agent_conversations WHERE platform_conversation_id LIKE 'test-%')\");
      await client.query(\"DELETE FROM remote_agent_conversations WHERE platform_conversation_id LIKE 'test-%'\");
      await client.query(\"DELETE FROM remote_agent_codebases WHERE name LIKE 'remote-coding-test-%'\");
      await client.end();
      console.log('Database cleaned');
    }
    cleanup().catch(console.error);
  "
fi

export WORK_DIR
```

### 2.1 Store ngrok URL
```bash
NGROK_URL="$ARGUMENTS"
echo "Using ngrok URL: ${NGROK_URL}"

if [[ ! "$NGROK_URL" =~ ^https:// ]]; then
  echo "ERROR: Invalid ngrok URL format. Expected: https://..."
  exit 1
fi

export NGROK_URL
```

### 2.2 Generate Repository Name
```bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
TEST_REPO_NAME="remote-coding-test-${TIMESTAMP}"
echo "Test repository: ${TEST_REPO_NAME}"

# Get GitHub username
GITHUB_USERNAME=$(gh api user --jq .login)
echo "GitHub user: ${GITHUB_USERNAME}"

export TEST_REPO_NAME
export GITHUB_USERNAME
```

### 2.3 Create Test Repository Structure
```bash
mkdir -p "${WORK_DIR}/${GITHUB_USERNAME}"
cd "${WORK_DIR}/${GITHUB_USERNAME}"
mkdir ${TEST_REPO_NAME}
cd ${TEST_REPO_NAME}

# Initialize git
git init
git config user.email "test@example.com"
git config user.name "Test User"

# Create README
cat > README.md << 'EOF'
# Remote Coding Test Repository

This is a test repository for automated validation of the Remote Agentic Coding Platform.

## Purpose

Used for E2E testing of:
- Command invocation (prime, plan-feature, execute)
- GitHub webhook integration
- Worktree isolation
- AI-assisted development workflows
EOF

# Create .gitignore
cat > .gitignore << 'EOF'
node_modules
.next
.env*.local
EOF

# Create .archon/commands directory with test commands
mkdir -p .archon/commands

# Copy commands from main project
cp "${PROJECT_ROOT}/.archon/commands/prime.md" .archon/commands/ 2>/dev/null || \
cp "${PROJECT_ROOT}/.claude/commands/core_piv_loop/prime.md" .archon/commands/prime.md 2>/dev/null || \
cat > .archon/commands/prime.md << 'CMDEOF'
# Prime Command

Analyze this codebase and provide a brief summary of:
1. What this project does
2. Key files and their purposes
3. Main technologies used

Keep your response concise.
CMDEOF

cp "${PROJECT_ROOT}/.archon/commands/plan.md" .archon/commands/plan-feature.md 2>/dev/null || \
cp "${PROJECT_ROOT}/.claude/commands/core_piv_loop/plan-feature.md" .archon/commands/plan-feature.md 2>/dev/null || \
cat > .archon/commands/plan-feature.md << 'CMDEOF'
# Plan Feature Command

Create a simple implementation plan for:

$ARGUMENTS

Include:
1. Files to modify
2. Implementation steps
3. Validation approach
CMDEOF

cp "${PROJECT_ROOT}/.archon/commands/execute.md" .archon/commands/ 2>/dev/null || \
cat > .archon/commands/execute.md << 'CMDEOF'
# Execute Command

Implement the changes based on the previous plan.
If no plan exists, respond with: "No plan found. Run /command-invoke plan-feature first."
CMDEOF

# Commit
git add .
git commit -m "Initial test repository setup with archon commands"

echo "Repository structure created"
```

### 2.4 Push to GitHub (Personal Account)
```bash
# Create private repo in personal account (no org prefix)
gh repo create ${TEST_REPO_NAME} --private --source=. --push

TEST_REPO_URL=$(gh repo view --json url -q .url)
echo "Repository created: ${TEST_REPO_URL}"

export TEST_REPO_URL
```

### 2.5 Configure GitHub Webhook
```bash
cd "${PROJECT_ROOT}"
source .env

# Create webhook pointing to ngrok URL
gh api repos/${GITHUB_USERNAME}/${TEST_REPO_NAME}/hooks \
  -X POST \
  --input - <<EOF
{
  "name": "web",
  "active": true,
  "events": [
    "issues",
    "issue_comment",
    "pull_request",
    "pull_request_review_comment"
  ],
  "config": {
    "url": "${NGROK_URL}/webhooks/github",
    "content_type": "json",
    "secret": "${WEBHOOK_SECRET}",
    "insecure_ssl": "0"
  }
}
EOF

echo "Webhook configured: ${NGROK_URL}/webhooks/github"

# Verify webhook
gh api repos/${GITHUB_USERNAME}/${TEST_REPO_NAME}/hooks | jq '.[0] | {id, url: .config.url, events, active}'
```

---

## Phase 3: Docker Container Setup

### 3.1 Rebuild and Start Containers
```bash
cd "${PROJECT_ROOT}"
docker compose --profile with-db down 2>/dev/null || true
docker compose --profile with-db up -d --build
```

### 3.2 Wait for Startup
```bash
echo "Waiting for containers to start..."
sleep 15
docker compose ps
```

### 3.3 Verify Application Logs
```bash
docker compose logs app-with-db 2>&1 | tail -30
```

**Check for:**
- `[Archon] Paths configured:`
- `[App] Adapters initialized`
- `[App] Server listening on port 3090`
- `[ConversationLock] Initialized`

### 3.4 Health Checks
```bash
curl -s http://localhost:3090/health | jq
curl -s http://localhost:3090/health/db | jq
curl -s http://localhost:3090/health/concurrency | jq
```

**Expected:** All return `{"status":"ok",...}`

---

## Phase 4: Database Schema Validation

### 4.1 Verify All 6 Tables Exist
```bash
docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -c "\dt remote_agent_*"
```

**Expected tables:**
1. `remote_agent_codebases`
2. `remote_agent_conversations`
3. `remote_agent_sessions`
4. `remote_agent_command_templates`
5. `remote_agent_isolation_environments`
6. `remote_agent_workflow_runs`

### 4.2 Verify Foreign Keys
```bash
docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -c "SELECT conname, conrelid::regclass, confrelid::regclass
      FROM pg_constraint
      WHERE contype = 'f' AND connamespace = 'public'::regnamespace
      AND conrelid::regclass::text LIKE 'remote_agent_%';"
```

**Expected:** 7 foreign key relationships

---

## Phase 5: Test Adapter E2E Tests

### 5.1 Basic Commands
```bash
curl -X DELETE http://localhost:3000/test/messages/test-basic

curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-basic","message":"/help"}'

sleep 2

HELP=$(curl -s http://localhost:3000/test/messages/test-basic | jq -r '.messages[0].message')
echo "$HELP" | grep -q "/repos" && echo "✅ /repos in help" || echo "❌ /repos missing"
echo "$HELP" | grep -q "/worktree" && echo "✅ /worktree in help" || echo "❌ /worktree missing"
```

### 5.2 Clone Test Repository
```bash
curl -X DELETE http://localhost:3000/test/messages/test-clone

curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d "{\"conversationId\":\"test-clone\",\"message\":\"/clone https://github.com/${GITHUB_USERNAME}/${TEST_REPO_NAME}\"}"

echo "Waiting for clone..."
sleep 30

CLONE_MSG=$(curl -s http://localhost:3000/test/messages/test-clone | jq -r '.messages[-1].message')
echo "$CLONE_MSG" | grep -q "cloned successfully\|Linked to\|Loaded" && echo "✅ Clone succeeded" || echo "❌ Clone failed: $CLONE_MSG"
```

### 5.3 Verify Commands Auto-Loaded
```bash
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-clone","message":"/commands"}'

sleep 2

CMDS=$(curl -s http://localhost:3000/test/messages/test-clone | jq -r '.messages[-1].message')
echo "$CMDS" | grep -q "prime" && echo "✅ prime command loaded" || echo "❌ prime missing"
echo "$CMDS" | grep -q "plan-feature" && echo "✅ plan-feature command loaded" || echo "❌ plan-feature missing"
echo "$CMDS" | grep -q "execute" && echo "✅ execute command loaded" || echo "❌ execute missing"
```

### 5.4 Test /getcwd Command
```bash
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-clone","message":"/getcwd"}'

sleep 2

CWD_MSG=$(curl -s http://localhost:3000/test/messages/test-clone | jq -r '.messages[-1].message')
echo "$CWD_MSG" | grep -q "archon\|workspaces" && echo "✅ /getcwd works" || echo "❌ /getcwd failed"
```

### 5.5 Test /repos Command
```bash
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-clone","message":"/repos"}'

sleep 2

REPOS_MSG=$(curl -s http://localhost:3000/test/messages/test-clone | jq -r '.messages[-1].message')
echo "$REPOS_MSG" | grep -q "remote-coding-test\|Repositories" && echo "✅ /repos works" || echo "❌ /repos failed"
```

### 5.6 Test /templates Command
```bash
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-clone","message":"/templates"}'

sleep 2

TEMPLATES_MSG=$(curl -s http://localhost:3000/test/messages/test-clone | jq -r '.messages[-1].message')
echo "$TEMPLATES_MSG" | grep -q "commit\|review-pr\|plan\|Template" && echo "✅ /templates works" || echo "❌ /templates failed"
```

### 5.7 Test /status Command
```bash
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-clone","message":"/status"}'

sleep 2

STATUS_MSG=$(curl -s http://localhost:3000/test/messages/test-clone | jq -r '.messages[-1].message')
echo "$STATUS_MSG" | grep -q "Platform:\|Codebase:\|Working Directory" && echo "✅ /status works" || echo "❌ /status failed"
```

### 5.8 Test /setcwd Command
```bash
# Get current cwd first
ORIGINAL_CWD=$(curl -s http://localhost:3000/test/messages/test-clone | jq -r '.messages[-1].message' | grep -o '/[^ ]*archon[^ ]*' | head -1)

# Test setcwd with valid path
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d "{\"conversationId\":\"test-clone\",\"message\":\"/setcwd /.archon/workspaces/${GITHUB_USERNAME}/${TEST_REPO_NAME}\"}"

sleep 2

SETCWD_MSG=$(curl -s http://localhost:3000/test/messages/test-clone | jq -r '.messages[-1].message')
echo "$SETCWD_MSG" | grep -qi "set to\|working directory\|changed" && echo "✅ /setcwd works" || echo "❌ /setcwd failed"
```

### 5.9 Test /init Command (in test conversation)
```bash
curl -X DELETE http://localhost:3000/test/messages/test-init

curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-init","message":"/init"}'

sleep 2

INIT_MSG=$(curl -s http://localhost:3000/test/messages/test-init | jq -r '.messages[-1].message')
echo "$INIT_MSG" | grep -qi "created\|initialized\|already exists\|no codebase" && echo "✅ /init works" || echo "❌ /init failed"
```

### 5.10 Test /reset Command
```bash
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-clone","message":"/reset"}'

sleep 2

RESET_MSG=$(curl -s http://localhost:3000/test/messages/test-clone | jq -r '.messages[-1].message')
echo "$RESET_MSG" | grep -qi "reset\|cleared\|session" && echo "✅ /reset works" || echo "❌ /reset failed"
```

---

## Phase 6: Worktree Isolation Tests

### 6.1 Create Worktree via Test Adapter
```bash
curl -X DELETE http://localhost:3000/test/messages/test-worktree

curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d "{\"conversationId\":\"test-worktree\",\"message\":\"/clone https://github.com/${GITHUB_USERNAME}/${TEST_REPO_NAME}\"}"

sleep 15

curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-worktree","message":"/worktree create test-validation-branch"}'

sleep 5

WT_MSG=$(curl -s http://localhost:3000/test/messages/test-worktree | jq -r '.messages[-1].message')
echo "$WT_MSG" | grep -q "Worktree created\|Working in isolated" && echo "✅ Worktree created" || echo "❌ Worktree failed: $WT_MSG"
```

### 6.2 Verify Database Entry
```bash
docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -c "SELECT workflow_type, workflow_id, branch_name, status, created_by_platform
      FROM remote_agent_isolation_environments
      WHERE workflow_id LIKE '%test-validation%'
      ORDER BY created_at DESC LIMIT 1;"
```

**Expected:** Row with `workflow_type=task`, `status=active`, `created_by_platform=test`

### 6.3 List and Remove Worktree
```bash
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-worktree","message":"/worktree list"}'

sleep 2

curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-worktree","message":"/worktree remove"}'

sleep 3

WT_REMOVE=$(curl -s http://localhost:3000/test/messages/test-worktree | jq -r '.messages[-1].message')
echo "$WT_REMOVE" | grep -q "removed\|Switched back" && echo "✅ Worktree removed" || echo "❌ Remove failed"

# Verify status updated
docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -c "SELECT status FROM remote_agent_isolation_environments
      WHERE workflow_id LIKE '%test-validation%'
      ORDER BY created_at DESC LIMIT 1;"
```

**Expected:** `status=destroyed`

### 6.4 Test /worktree cleanup Command
```bash
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-worktree","message":"/worktree cleanup merged"}'

sleep 3

CLEANUP_MSG=$(curl -s http://localhost:3000/test/messages/test-worktree | jq -r '.messages[-1].message')
echo "$CLEANUP_MSG" | grep -qi "cleanup\|removed\|no.*merged\|worktree" && echo "✅ /worktree cleanup works" || echo "❌ /worktree cleanup failed"
```

### 6.5 Test /worktree orphans Command
```bash
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-worktree","message":"/worktree orphans"}'

sleep 2

ORPHANS_MSG=$(curl -s http://localhost:3000/test/messages/test-worktree | jq -r '.messages[-1].message')
echo "$ORPHANS_MSG" | grep -q "worktree\|main\|branch" && echo "✅ /worktree orphans works" || echo "❌ /worktree orphans failed"
```

---

## Phase 7: Command Workflow Tests (Test Adapter - Quick Validation)

This phase validates that commands work via the Test Adapter. Phase 8 tests the full workflow via GitHub.

### 7.1 Invoke Prime Command
```bash
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-clone","message":"/command-invoke prime"}'

echo "Waiting for prime (60 seconds)..."
sleep 60

PRIME=$(curl -s http://localhost:3000/test/messages/test-clone | jq -r '.messages[-1].message')
PRIME_LEN=${#PRIME}
echo "Prime response length: $PRIME_LEN"
[ $PRIME_LEN -gt 100 ] && echo "✅ Prime generated output" || echo "❌ Prime too short"
```

### 7.2 Verify Session State
```bash
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-clone","message":"/status"}'

sleep 2

STATUS=$(curl -s http://localhost:3000/test/messages/test-clone | jq -r '.messages[-1].message')
echo "$STATUS" | grep -q "Active Session" && echo "✅ Session active" || echo "❌ No active session"
```

---

## Phase 8: GitHub Issue Full Workflow (Prime → Plan → Execute → PR)

**This is the critical E2E test.** It validates the complete workflow through GitHub webhooks:
1. Create issue with feature request
2. Invoke `prime` via issue comment
3. Invoke `plan-feature` via issue comment
4. Invoke `execute` via issue comment
5. Verify bot creates a PR to resolve the issue

### 8.1 Create GitHub Issue (No Bot Mention)
```bash
cd "${WORK_DIR}/${GITHUB_USERNAME}/${TEST_REPO_NAME}"

# Create issue WITHOUT @Archon mention - workflow starts with comments
ISSUE_URL=$(gh issue create \
  --title "Add Validation Section to README" \
  --body "## Feature Request

Please add a 'Validation' section to README.md that explains:
- How to run the test suite
- How to validate the platform is working
- Basic troubleshooting steps

This section should be added after the 'Purpose' section.

## Acceptance Criteria
- [ ] New 'Validation' section exists in README.md
- [ ] Section includes test commands
- [ ] Section includes troubleshooting tips" \
  | grep -o 'https://.*')

ISSUE_NUMBER=$(echo $ISSUE_URL | grep -o '[0-9]*$')
echo "Issue created: ${ISSUE_URL}"
echo "Issue number: ${ISSUE_NUMBER}"

export ISSUE_NUMBER
export ISSUE_URL

cd "${PROJECT_ROOT}"
```

### 8.2 Invoke Prime Command via GitHub Comment (Starts Workflow)
```bash
cd "${WORK_DIR}/${GITHUB_USERNAME}/${TEST_REPO_NAME}"

# This is the first @Archon mention - triggers worktree creation
gh issue comment ${ISSUE_NUMBER} --body "@Archon /command-invoke prime"

echo "Waiting for prime to complete (90 seconds)..."
sleep 90

# Check for prime response
gh issue view ${ISSUE_NUMBER} --comments | tail -40

cd "${PROJECT_ROOT}"
```

**Expected:**
- Bot creates worktree for issue
- Bot responds with codebase analysis (project purpose, key files, technologies)

### 8.3 Invoke Plan-Feature Command via GitHub Comment
```bash
cd "${WORK_DIR}/${GITHUB_USERNAME}/${TEST_REPO_NAME}"

gh issue comment ${ISSUE_NUMBER} --body "@Archon /command-invoke plan-feature \"Add a Validation section to README.md after the Purpose section, explaining how to run tests and validate the platform\""

echo "Waiting for plan to complete (120 seconds)..."
sleep 120

# Check for plan response
gh issue view ${ISSUE_NUMBER} --comments | tail -50

cd "${PROJECT_ROOT}"
```

**Expected:** Bot responds with implementation plan including:
- Files to modify
- Implementation steps
- Validation approach

### 8.4 Invoke Execute Command via GitHub Comment
```bash
cd "${WORK_DIR}/${GITHUB_USERNAME}/${TEST_REPO_NAME}"

gh issue comment ${ISSUE_NUMBER} --body "@Archon /command-invoke execute"

echo "Waiting for execute to complete (180 seconds)..."
sleep 180

# Check for execute response and PR creation
gh issue view ${ISSUE_NUMBER} --comments | tail -60

cd "${PROJECT_ROOT}"
```

**Expected:** Bot:
1. Implements the changes to README.md
2. Creates a commit
3. Creates a pull request
4. Comments with PR link

### 8.5 Verify PR Was Created
```bash
cd "${WORK_DIR}/${GITHUB_USERNAME}/${TEST_REPO_NAME}"

# List PRs to find the one created by the bot
BOT_PR=$(gh pr list --state open --json number,title,headRefName --jq '.[0]')
echo "Bot-created PR: ${BOT_PR}"

# Get PR number if exists
BOT_PR_NUMBER=$(echo $BOT_PR | jq -r '.number // empty')

if [ -n "$BOT_PR_NUMBER" ]; then
  echo "✅ PR #${BOT_PR_NUMBER} created by bot"
  gh pr view ${BOT_PR_NUMBER}
else
  echo "⚠️ No PR found - check issue comments for errors"
  gh issue view ${ISSUE_NUMBER} --comments | tail -30
fi

cd "${PROJECT_ROOT}"
```

### 8.6 Verify Worktree and Database State
```bash
# Check isolation environment
docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -c "SELECT workflow_type, workflow_id, branch_name, status, created_by_platform
      FROM remote_agent_isolation_environments
      WHERE workflow_type = 'issue' AND workflow_id = '${ISSUE_NUMBER}'
      ORDER BY created_at DESC LIMIT 1;"

# Check workflow runs
docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -c "SELECT id, status, started_at, completed_at
      FROM remote_agent_workflow_runs
      ORDER BY created_at DESC LIMIT 3;"
```

**Expected:**
- `workflow_type=issue`, `status=active`, `created_by_platform=github`
- Workflow runs showing completed status

### 8.7 Verify Tool Execution in Logs
```bash
docker compose logs app-with-db 2>&1 | grep -E "Tool call:|Bash|Read|Edit|Write" | tail -20
```

**Expected:** Multiple tool calls showing the bot actually executed tools (Read, Edit/Write, Bash for git)

### 8.8 Verify PR Shares Worktree with Linked Issue
```bash
# This test verifies the intelligent worktree sharing behavior
# When a PR references an issue (e.g., "Closes #1"), it should share the issue's worktree

# Get isolation env ID for the issue
ISSUE_ENV_ID=$(docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -t -c "SELECT isolation_env_id FROM remote_agent_conversations
         WHERE platform_conversation_id LIKE '%${GITHUB_USERNAME}/${TEST_REPO_NAME}#${ISSUE_NUMBER}';" | tr -d ' ')

echo "Issue #${ISSUE_NUMBER} isolation env: $ISSUE_ENV_ID"

# After PR is created, check if it shares the same env (will be verified in Phase 9)
if [ -n "$ISSUE_ENV_ID" ]; then
  echo "✅ Issue has isolation environment"
else
  echo "⚠️ Issue isolation env not found (may be expected)"
fi
```

---

## Phase 9: GitHub PR Review (Review Bot-Created PR)

This phase reviews the PR that was created by the execute command in Phase 8.

### 9.1 Get PR Number from Phase 8
```bash
cd "${WORK_DIR}/${GITHUB_USERNAME}/${TEST_REPO_NAME}"

# Get the PR created by the bot in Phase 8
PR_NUMBER=$(gh pr list --state open --json number --jq '.[0].number')

if [ -z "$PR_NUMBER" ]; then
  echo "❌ No open PR found - Phase 8 may have failed"
  exit 1
fi

echo "PR to review: #${PR_NUMBER}"
PR_URL=$(gh pr view ${PR_NUMBER} --json url --jq '.url')
echo "PR URL: ${PR_URL}"

export PR_NUMBER
export PR_URL

cd "${PROJECT_ROOT}"
```

### 9.2 Invoke PR Review via Comment
```bash
cd "${WORK_DIR}/${GITHUB_USERNAME}/${TEST_REPO_NAME}"

gh pr comment ${PR_NUMBER} --body "@Archon /command-invoke review-pr"

echo "Waiting for PR review to complete (120 seconds)..."
sleep 120

# Check for review response
gh pr view ${PR_NUMBER} --comments | tail -50

cd "${PROJECT_ROOT}"
```

**Expected:** Bot responds with code review including:
- Summary of changes
- Code quality assessment
- Any issues or suggestions
- Approval or request for changes

### 9.3 Verify PR Worktree Created
```bash
docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -c "SELECT workflow_type, workflow_id, branch_name, status, created_by_platform
      FROM remote_agent_isolation_environments
      WHERE workflow_type = 'pr'
      ORDER BY created_at DESC LIMIT 1;"
```

**Expected:** Row with `workflow_type=pr`, `workflow_id=${PR_NUMBER}`, `created_by_platform=github`

### 9.4 Verify Review Tool Execution
```bash
docker compose logs app-with-db 2>&1 | grep -E "pr-${PR_NUMBER}|Tool call:" | tail -15
```

**Expected:** Tool calls showing the bot read files, ran diff commands, etc.

### 9.5 Check Full PR State
```bash
cd "${WORK_DIR}/${GITHUB_USERNAME}/${TEST_REPO_NAME}"

echo "=== PR Details ==="
gh pr view ${PR_NUMBER}

echo ""
echo "=== PR Diff ==="
gh pr diff ${PR_NUMBER} | head -50

cd "${PROJECT_ROOT}"
```

**Expected:**
- PR shows the README.md changes
- Bot review comment visible
- PR ready for merge (if review passed)

### 9.6 Verify PR Shares Worktree with Issue (Completion)
```bash
# Complete the verification started in Phase 8.8
PR_ENV_ID=$(docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -t -c "SELECT isolation_env_id FROM remote_agent_conversations
         WHERE platform_conversation_id LIKE '%${GITHUB_USERNAME}/${TEST_REPO_NAME}#${PR_NUMBER}';" | tr -d ' ')

echo "PR #${PR_NUMBER} isolation env: $PR_ENV_ID"

if [ -n "$ISSUE_ENV_ID" ] && [ "$ISSUE_ENV_ID" = "$PR_ENV_ID" ]; then
  echo "✅ PR shares worktree with linked issue (intelligent sharing)"
elif [ -n "$PR_ENV_ID" ]; then
  echo "⚠️ PR has different isolation env (may be expected if not linked)"
else
  echo "⚠️ PR isolation env not found"
fi
```

### 9.7 Test GitHub Issue Close Event (Cleanup Trigger)
```bash
cd "${WORK_DIR}/${GITHUB_USERNAME}/${TEST_REPO_NAME}"

# Close the issue to trigger cleanup event
echo "Closing issue #${ISSUE_NUMBER} to test cleanup trigger..."
gh issue close ${ISSUE_NUMBER}

sleep 10

# Check logs for cleanup trigger
docker compose logs app-with-db 2>&1 | tail -30 | grep -qi "closed\|cleanup\|onConversationClosed" && \
  echo "✅ Close event detected in logs" || echo "⚠️ Close event not clearly logged (may still work)"

# Reopen the issue for manual inspection
echo "Reopening issue for manual inspection..."
gh issue reopen ${ISSUE_NUMBER}

cd "${PROJECT_ROOT}"
```

---

## Phase 10: Concurrency Tests

```bash
echo "Testing concurrent message handling..."

for i in 1 2 3; do
  curl -X POST http://localhost:3000/test/message \
    -H "Content-Type: application/json" \
    -d "{\"conversationId\":\"concurrent-${i}\",\"message\":\"/help\"}" &
done

wait
sleep 5

SUCCESS=0
for i in 1 2 3; do
  RESP=$(curl -s http://localhost:3000/test/messages/concurrent-${i} | jq -r '.messages[0].message // empty')
  if echo "$RESP" | grep -q "Available Commands"; then
    ((SUCCESS++))
  fi
done

echo "Concurrent messages processed: $SUCCESS/3"
[ $SUCCESS -eq 3 ] && echo "✅ Concurrency works" || echo "❌ Some failed"

curl -s http://localhost:3000/health/concurrency | jq
```

---

## Phase 11: Error Handling Tests

### 11.1 Invalid Command
```bash
curl -X DELETE http://localhost:3000/test/messages/test-error

curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-error","message":"/nonexistent-command"}'

sleep 2

ERR=$(curl -s http://localhost:3000/test/messages/test-error | jq -r '.messages[0].message')
echo "$ERR" | grep -qi "unknown\|not found" && echo "✅ Invalid command handled" || echo "⚠️ Error unclear"
```

### 11.2 Invalid Clone
```bash
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-error","message":"/clone https://github.com/nonexistent-user-xyz/fake-repo"}'

sleep 15

CLONE_ERR=$(curl -s http://localhost:3000/test/messages/test-error | jq -r '.messages[-1].message')
echo "$CLONE_ERR" | grep -qi "failed\|error\|not found" && echo "✅ Invalid clone handled" || echo "⚠️ Error unclear"
```

---

## Phase 12: Database Consistency Checks

### 12.1 Check for Orphaned Sessions
```bash
echo "=== Database Consistency Checks ==="

# Check for sessions without a valid conversation
ORPHAN_SESSIONS=$(docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -t -c "SELECT COUNT(*) FROM remote_agent_sessions
         WHERE conversation_id NOT IN (SELECT id FROM remote_agent_conversations);" | tr -d ' ')

echo "Orphaned sessions (no conversation): $ORPHAN_SESSIONS"
[ "$ORPHAN_SESSIONS" = "0" ] && echo "✅ No orphaned sessions" || echo "❌ Found orphaned sessions"
```

### 12.2 Check for Orphaned Isolation Environments
```bash
# Check for isolation envs without a valid codebase
ORPHAN_ENVS=$(docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -t -c "SELECT COUNT(*) FROM remote_agent_isolation_environments
         WHERE codebase_id NOT IN (SELECT id FROM remote_agent_codebases);" | tr -d ' ')

echo "Orphaned isolation envs (no codebase): $ORPHAN_ENVS"
[ "$ORPHAN_ENVS" = "0" ] && echo "✅ No orphaned isolation envs" || echo "❌ Found orphaned isolation envs"
```

### 12.3 Check for Orphaned Workflow Runs
```bash
# Check for workflow runs without a valid conversation
ORPHAN_RUNS=$(docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -t -c "SELECT COUNT(*) FROM remote_agent_workflow_runs
         WHERE conversation_id NOT IN (SELECT id FROM remote_agent_conversations);" | tr -d ' ')

echo "Orphaned workflow runs (no conversation): $ORPHAN_RUNS"
[ "$ORPHAN_RUNS" = "0" ] && echo "✅ No orphaned workflow runs" || echo "❌ Found orphaned workflow runs"
```

### 12.4 Check Active Isolation Envs Have Filesystem Worktrees
```bash
echo "Checking active isolation envs have filesystem worktrees..."
MISSING_WT=0

# Get all active working paths for test repo
docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -t -c "SELECT working_path FROM remote_agent_isolation_environments
         WHERE status = 'active' AND working_path LIKE '%${TEST_REPO_NAME}%';" | \
while read -r path; do
  path=$(echo "$path" | tr -d ' ')
  if [ -n "$path" ]; then
    docker compose exec app-with-db sh -c "[ -d '$path' ]" 2>/dev/null
    if [ $? -eq 0 ]; then
      echo "  ✅ Exists: $path"
    else
      echo "  ❌ MISSING: $path"
      MISSING_WT=$((MISSING_WT + 1))
    fi
  fi
done

[ "$MISSING_WT" = "0" ] && echo "✅ All active worktrees exist on filesystem" || echo "❌ Some worktrees missing"
```

---

## Phase 13: Final Validation Summary

```bash
echo "========================================"
echo "VALIDATION SUMMARY"
echo "========================================"
echo ""
echo "Test Repository: ${TEST_REPO_URL}"
echo "Issue #${ISSUE_NUMBER}: ${ISSUE_URL}"
echo "Bot-Created PR #${PR_NUMBER}: ${PR_URL}"
echo ""

# Docker status
echo "Docker Status:"
docker compose ps --format "table {{.Name}}\t{{.Status}}"
echo ""

# Database tables
echo "Database Tables:"
TABLE_COUNT=$(docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'remote_agent_%';")
echo "Tables: $TABLE_COUNT (expected: 6)"
echo ""

# Isolation environments
echo "Isolation Environments Created:"
docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -c "SELECT workflow_type, workflow_id, status, created_by_platform
      FROM remote_agent_isolation_environments
      ORDER BY created_at DESC LIMIT 5;"
echo ""

# Workflow summary
echo "GitHub Workflow Results:"
cd "${WORK_DIR}/${GITHUB_USERNAME}/${TEST_REPO_NAME}"
echo "  Issue comments: $(gh issue view ${ISSUE_NUMBER} --json comments --jq '.comments | length')"
echo "  PR created: $(gh pr list --state all --json number --jq 'length > 0')"
if [ -n "$PR_NUMBER" ]; then
  echo "  PR #${PR_NUMBER} status: $(gh pr view ${PR_NUMBER} --json state --jq '.state')"
fi
cd "${PROJECT_ROOT}"
echo ""

# Health checks
echo "Health Checks:"
curl -s http://localhost:3000/health | jq -r '.status'
curl -s http://localhost:3000/health/db | jq -r '.status'
echo ""

# Error count
ERROR_COUNT=$(docker compose logs app-with-db 2>&1 | grep -c -E "ERROR|Error:" || echo "0")
echo "Errors in logs: ${ERROR_COUNT}"
echo ""

echo "========================================"
echo "VALIDATION COMPLETE"
echo "========================================"

# Final checklist
echo ""
echo "CHECKLIST:"
echo "  [ ] Phase 1: Foundation tests passed"
echo "  [ ] Phase 8: Bot created PR from issue workflow"
echo "  [ ] Phase 9: Bot reviewed the PR"
echo "  [ ] All health checks OK"
echo "  [ ] Zero errors in logs"
```

---

## Phase 14: Cleanup

**Test repository is preserved for manual inspection.**

When ready to clean up:
```bash
# Delete GitHub repository
gh repo delete ${GITHUB_USERNAME}/${TEST_REPO_NAME} --yes

# Remove local files
rm -rf "${WORK_DIR}/${GITHUB_USERNAME}/${TEST_REPO_NAME}"
rm -rf "${HOME}/.archon/worktrees/${GITHUB_USERNAME}/${TEST_REPO_NAME}"

# Clean database
docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -c "DELETE FROM remote_agent_isolation_environments WHERE workflow_id LIKE '%${TEST_REPO_NAME}%';"
docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -c "DELETE FROM remote_agent_codebases WHERE name = '${TEST_REPO_NAME}';"
```

---

## Success Criteria

| Phase | Criteria |
|-------|----------|
| 1.x | Type-check, lint, format, build pass |
| 2.x | Test repo created with webhook configured |
| 3.x | Docker containers running, health checks pass |
| 4.x | All 6 database tables exist with FKs |
| 5.x | Test adapter commands work (/help, /clone, /commands, /repos, /templates, /status, /getcwd, /setcwd, /init, /reset) |
| 6.x | Worktree create/list/remove/cleanup/orphans work with DB tracking |
| 7.x | Command invocation works via Test Adapter (prime) |
| 8.x | **Full GitHub Issue Workflow:** prime → plan-feature → execute → PR created, worktree sharing verified |
| 9.x | **PR Review via GitHub:** Bot reviews the created PR, close event triggers cleanup |
| 10.x | Concurrent requests handled correctly |
| 11.x | Error handling is graceful |
| 12.x | Database consistency: no orphaned sessions, isolation envs, or workflow runs |

**If ALL phases pass, the Remote Coding Agent is production-ready.**

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Webhook not triggering | Verify ngrok is running, check URL matches |
| Worktree creation fails | Check git permissions, disk space |
| Database errors | Run migrations: `psql $DATABASE_URL < migrations/000_combined.sql` |
| Clone fails | Check GITHUB_TOKEN in .env |
| Bot not responding | Check docker logs for errors |
