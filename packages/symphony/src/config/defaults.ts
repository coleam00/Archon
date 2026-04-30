/**
 * Symphony runtime defaults. Only the blocks Phase 2 needs (polling,
 * dispatch slots, retry backoff). Tracker defaults are per-tracker now —
 * see `snapshot.ts`. The legacy agent/codex/claude blocks moved to
 * per-workflow YAML inside Archon proper.
 */
export const DEFAULTS = {
  polling: {
    interval_ms: 30_000,
  },
  dispatch: {
    max_concurrent: 10,
    max_concurrent_by_state: {} as Record<string, number>,
    retry: {
      continuation_delay_ms: 1_000,
      failure_base_delay_ms: 10_000,
      max_backoff_ms: 300_000,
    },
  },
  tracker: {
    endpoint_linear: 'https://api.linear.app/graphql',
    linear_active_states: ['Todo', 'In Progress'] as string[],
    linear_terminal_states: ['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done'] as string[],
    github_active_states: ['open'] as string[],
    github_terminal_states: ['closed'] as string[],
  },
} as const;
