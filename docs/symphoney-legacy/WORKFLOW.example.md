---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: my-team-project-slug
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Closed
    - Cancelled
    - Canceled
    - Duplicate

polling:
  interval_ms: 30000

workspace:
  root: ~/symphony_workspaces

hooks:
  after_create: |
    git init -q
    echo "workspace ready"
  before_run: |
    echo "starting attempt for {{ issue.identifier }}"
  timeout_ms: 60000

agent:
  # Backend selects which coding-agent driver to run. Default: codex.
  #   "codex"  — shells out to a Codex-compatible app server over stdio JSON.
  #   "claude" — uses the Claude Agent SDK in-process (requires Claude Code OAuth or ANTHROPIC_API_KEY).
  backend: codex
  max_concurrent_agents: 4
  max_turns: 20
  max_retry_backoff_ms: 300000
  # Sent on continuation turns (turn 2..N). The first-turn prompt is the
  # rendered workflow body below; spec §7 requires continuation turns to send
  # only continuation guidance, not the full task prompt again.
  # continuation_prompt: "Continue. If complete, call linear_graphql to transition the issue and stop."

codex:
  command: codex app-server
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000

# Used when agent.backend = "claude".
# claude:
#   model: claude-sonnet-4-6
#   allowed_tools: [Read, Edit, Write, Glob, Grep, Bash]
#   permission_mode: bypassPermissions
#   force_subscription_auth: false
#   turn_timeout_ms: 3600000
#   read_timeout_ms: 30000
#   stall_timeout_ms: 300000
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

When the work is complete, call the `linear_graphql` tool to move the Linear issue to `Done` (or your handoff state, e.g., `Human Review`). The orchestrator detects the state change and stops the worker. Without this call, the worker will continue prompting you up to `agent.max_turns` times.
