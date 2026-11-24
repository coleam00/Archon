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
  // Under `runs:` on purpose: the dashboard SSE and every answer panel invalidate `runs`,
  // so a run moving on or an answer given refreshes a project's queue too.
  projectAttention: (projectId: string): string => `runs:attention:project:${projectId}`,
  runs: (scope: Scope): string => `runs:${scopeKey(scope)}`,
  run: (id: string): string => `run:${id}`,
  metrics: (scope: Scope, since: string): string => `metrics:${scopeKey(scope)}:${since}`,
  metricViews: (scope: Scope): string => `metric-views:${scopeKey(scope)}`,
  factoryViews: (projectId: string): string => `factory-views:${projectId}`,
  // Under `projects:` on purpose: adding, removing or renaming a project invalidates
  // `projects`, and the packs list which projects run each pack.
  factoryPacks: 'projects:factory-packs' as const,
  // Under `projects:` for the same reason: the page lists what each project of the pack sets.
  factoryPackSettings: (packKey: string): string => `projects:factory-pack-settings:${packKey}`,
  factoryWorkflow: (projectId: string, workflow: string): string =>
    `factory-workflow:${projectId}:${workflow}`,
  // Every page of one project's items; the dashboard SSE invalidates the `factory-items` prefix.
  factoryItems: (projectId: string): string => `factory-items:${projectId}`,
  // Under the same prefix, so the dashboard SSE refreshes one item's page too.
  factoryItem: (projectId: string, key: string): string => `factory-items:${projectId}:item:${key}`,
  // A project's items without the factory progress join, for a project no factory view applies to.
  projectItems: (projectId: string): string => `factory-items:${projectId}:window`,
  // Under the same prefix, so a drain that ends refreshes what the drains decided.
  factoryDiscoveries: (projectId: string): string => `factory-items:${projectId}:discoveries`,
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
  updateCheck: 'update-check' as const,
  githubConnection: 'github-connection' as const,
  providerConnections: 'provider-connections' as const,
  userAiPrefs: 'user-ai-prefs' as const,
  piModels: 'pi-models' as const,
} as const;
