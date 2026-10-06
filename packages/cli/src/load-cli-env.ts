import { loadArchonEnv } from '@archon/paths/env-loader';

/**
 * Load ~/.archon/.env and <cwd>/.archon/.env into process.env for CLI startup, and
 * return the environment forge plugin processes run with.
 *
 * Inside a run, a GitHub key the engine set (a token, or '' to scrub it) is the run's
 * identity; neither Archon env file may replace or restore it. An absent key is no
 * opinion, so the env files still supply it (see github-token-policy). Imported only
 * inside a run: CLI startup must not load workflow modules (check:cli-import-boundary).
 */
export async function loadCliEnv(cwd: string): Promise<NodeJS.ProcessEnv> {
  const runGithubCredentials = process.env.WORKFLOW_ID
    ? (await import('@archon/workflows/utils/github-token-policy')).GITHUB_TOKEN_KEYS.flatMap(
        key => {
          const value = process.env[key];
          return value === undefined ? [] : [[key, value] as const];
        }
      )
    : [];
  let forgeTrustedEnv: NodeJS.ProcessEnv = {};
  loadArchonEnv(cwd, {
    afterUserLoad: () => {
      // Forge plugin processes run with the environment as the user scope left it, so
      // the repository's `.archon/.env` can supply a credential (passed separately) but
      // cannot change the environment an executable plugin runs in.
      forgeTrustedEnv = { ...process.env };
    },
  });
  for (const [key, value] of runGithubCredentials) process.env[key] = value;
  return forgeTrustedEnv;
}
