/** Centralized cache key constructors. Refactoring key shape = one file. */

/** A scope is either the literal 'all' or a project id. Encoded as a string. */
export type Scope = string;
export const ALL_SCOPE = 'all';

export const scopeKey = (scope: Scope): string =>
  scope === ALL_SCOPE ? 'all' : `project:${scope}`;

export const K = {
  projects: 'projects' as const,
  project: (id: string): string => `project:${id}`,
  workflows: (cwd: string): string => `workflows:${cwd}`,
  // Encode both parts: workflow names may contain `:`, so a raw join could let
  // distinct (cwd, name) pairs collapse to the same cache key.
  workflow: (cwd: string, name: string): string =>
    `workflow:${encodeURIComponent(cwd)}:${encodeURIComponent(name)}`,
  worktrees: (projectId: string): string => `worktrees:${projectId}`,
  runsAttention: 'runs:attention' as const,
  /** How many things wait on the operator, for the rail; only the attention stream refetches it. */
  needsYouCount: 'needs-you:count' as const,
  /** A project's open items, as the board lists them. Run and attention events refetch `board:*`. */
  board: (projectId: string): string => `board:${projectId}`,
  /** The newest few items at rest of one pack; under `board:` so the same events refetch it. */
  /** The newest failed or stopped items of a project, which need a decision. */
  boardDecide: (projectId: string): string => `board:${projectId}:decide`,
  /** A pack's items with a run started since `since`, in any state. */
  boardSince: (projectId: string, pack: string, since: string): string =>
    `board:${projectId}:since:${pack}:${since}`,
  /** Every item of a project, for its work orders; under `board:` so the same events refetch it. */
  boardOrders: (projectId: string): string => `board:${projectId}:orders`,
  boardDone: (projectId: string, pack: string): string =>
    `board:${projectId}:done:${encodeURIComponent(pack)}`,
  /** The factory view a pack ships, which board cards read their words and declarations from. */
  packView: (projectId: string, pack: string): string =>
    `pack-view:${projectId}:${encodeURIComponent(pack)}`,
  /**
   * The run records a list of board cards reads, by the runs asked; under `board:`, so run and
   * attention events refetch the running step and rounds.
   */
  cardReads: (projectId: string, runs: readonly string[]): string =>
    `board:${projectId}:cards:${runs.join(',')}`,
  /** The forge's titles for some issues, which board cards print and the board filter searches. */
  forgeTitles: (projectId: string, issues: readonly number[]): string =>
    `forge-titles:${projectId}:${issues.join(',')}`,
  /** The forge's numbers for the pull requests some runs named. */
  forgeChanges: (projectId: string, changes: readonly { run: string; url: string }[]): string =>
    `forge-changes:${projectId}:${changes.map(c => `${c.run}@${encodeURIComponent(c.url)}`).join(',')}`,
  packGraph: (projectId: string, pack: string): string =>
    `pack-graph:${projectId}:${encodeURIComponent(pack)}`,
  runs: (scope: Scope): string => `runs:${scopeKey(scope)}`,
  run: (id: string): string => `run:${id}`,
  metrics: (scope: Scope, since: string): string => `metrics:${scopeKey(scope)}:${since}`,
  metricViews: (scope: Scope): string => `metric-views:${scopeKey(scope)}`,
  messages: (conversationId: string): string => `messages:${conversationId}`,
  conversations: (projectId: string): string => `conversations:${projectId}`,
  countsGlobal: 'counts:global' as const,
  pendingRuns: 'pendingRuns' as const,
  envVars: (projectId: string): string => `envVars:${projectId}`,
  artifacts: (runId: string): string => `artifacts:${runId}`,
  // Installation-wide settings surfaces (static keys — one row each).
  config: 'config' as const,
  // Health has two consumers — the Settings SystemPanel and the IDE docker-check.
  // Both must read via lib/health's useHealth() so they share this one cache entry
  // instead of issuing duplicate /api/health fetches.
  health: 'health' as const,
  providers: 'providers' as const,
  observing: 'observing' as const,
  updateCheck: 'update-check' as const,
  githubConnection: 'github-connection' as const,
  providerConnections: 'provider-connections' as const,
  userAiPrefs: 'user-ai-prefs' as const,
  piModels: 'pi-models' as const,
} as const;
