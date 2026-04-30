---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  # Wave 0.1: dell-omni-group "Symphony" project (team APP).
  # https://linear.app/dell-omni-group/project/symphony-60aa12712181
  project_slug: 60aa12712181
  repository: Ddell12/symphoney-codex
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Canceled

polling:
  interval_ms: 30000

workspace:
  root: ~/symphony_workspaces

hooks:
  # Wave 0.4: workspace = git worktree of ~/symphony-dev/symphoney-codex
  # branch sym/<ISSUE_IDENTIFIER>, branched from origin/main. The `if branch
  # exists` arm is the retry case (attempt N>=2 reuses the branch).
  after_create: |
    set -euo pipefail
    DEV_REPO="${SYMPHONY_DEV_REPO:-$HOME/symphony-dev/symphoney-codex}"
    BRANCH="sym/${ISSUE_IDENTIFIER}"
    git -C "$DEV_REPO" fetch origin main
    if git -C "$DEV_REPO" show-ref --verify --quiet "refs/heads/$BRANCH"; then
      git -C "$DEV_REPO" worktree add "$WORKSPACE_PATH" "$BRANCH"
    else
      git -C "$DEV_REPO" worktree add "$WORKSPACE_PATH" -b "$BRANCH" origin/main
    fi
  before_run: |
    set -euo pipefail
    cd "$WORKSPACE_PATH"
    pnpm install --frozen-lockfile
    pnpm typecheck
  before_remove: |
    set -euo pipefail
    DEV_REPO="${SYMPHONY_DEV_REPO:-$HOME/symphony-dev/symphoney-codex}"
    git -C "$DEV_REPO" worktree remove --force "$WORKSPACE_PATH" || true
  timeout_ms: 600000

agent:
  # Wave 0.7 first-dispatch ceremony: tighten until 3 clean dogfood PRs land,
  # then revert to max_concurrent_agents: 4 / max_turns: 20.
  backend: claude
  max_concurrent_agents: 1
  max_turns: 12
  max_retry_backoff_ms: 300000

codex:
  command: codex app-server
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000

claude:
  model: claude-sonnet-4-6
  force_subscription_auth: true
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
---

You are working on {{ issue.identifier }}: {{ issue.title }}.

{% if attempt %}
This is retry attempt {{ attempt }}. Inspect the workspace, read prior commit history, and continue where the previous attempt left off.
{% else %}
This is the first attempt. Read the issue carefully, then implement the change in this workspace.
{% endif %}

Issue description:
{{ issue.description }}

Labels: {% for label in issue.labels %}{{ label }}{% unless forloop.last %}, {% endunless %}{% endfor %}

## Completion protocol — DO IN THIS ORDER

1. Implement the change.
2. Run `pnpm typecheck && pnpm test` from the workspace root. Both MUST pass before you finish. If either fails, fix it.
3. Stage and commit ALL changes:
   ```
   git add -A
   git commit -m "<short summary tied to {{ issue.identifier }}>"
   ```
   Do NOT skip this step. The orchestrator will publish a PR from your committed work; uncommitted edits will be discarded.
4. Only AFTER the commit succeeds, call the `linear_graphql` tool to move the Linear issue to `Done` (or your handoff state, e.g., `Human Review`). The orchestrator detects the state change and stops the worker.

If you cannot complete the implementation, do NOT transition the issue. The worker will continue prompting you up to `agent.max_turns` times and then schedule a retry.
