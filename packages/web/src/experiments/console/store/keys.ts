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
  worktrees: (projectId: string): string => `worktrees:${projectId}`,
  runs: (scope: Scope): string => `runs:${scopeKey(scope)}`,
  run: (id: string): string => `run:${id}`,
  messages: (conversationId: string): string => `messages:${conversationId}`,
  countsGlobal: 'counts:global' as const,
  pendingRuns: 'pendingRuns' as const,
  envVars: (projectId: string): string => `envVars:${projectId}`,
  artifacts: (runId: string): string => `artifacts:${runId}`,
} as const;
