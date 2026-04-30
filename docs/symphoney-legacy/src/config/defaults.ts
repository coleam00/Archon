import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULTS = {
  tracker: {
    endpoint_linear: "https://api.linear.app/graphql",
    active_states: ["Todo", "In Progress"] as string[],
    terminal_states: ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"] as string[],
  },
  polling: {
    interval_ms: 30_000,
  },
  workspace: {
    rootDefault: () => join(tmpdir(), "symphony_workspaces"),
  },
  hooks: {
    timeout_ms: 60_000,
  },
  agent: {
    max_concurrent_agents: 10,
    max_turns: 20,
    max_retry_backoff_ms: 300_000,
    max_concurrent_agents_by_state: {} as Record<string, number>,
    continuation_prompt:
      "Continue. If the work for this issue is complete, call the linear_graphql tool to move it to a terminal state (e.g., Done) and stop. Otherwise keep going.",
  },
  codex: {
    command: "codex app-server",
    turn_timeout_ms: 3_600_000,
    read_timeout_ms: 5_000,
    stall_timeout_ms: 300_000,
  },
  claude: {
    allowed_tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"] as string[],
    permission_mode: "bypassPermissions" as const,
    force_subscription_auth: false,
    turn_timeout_ms: 3_600_000,
    read_timeout_ms: 30_000,
    stall_timeout_ms: 300_000,
  },
  http: {
    bind_host: "127.0.0.1",
  },
  retry: {
    continuation_delay_ms: 1_000,
    failure_base_delay_ms: 10_000,
  },
  agent_runtime: {
    pagination_page_size: 50,
    network_timeout_ms: 30_000,
  },
} as const;
