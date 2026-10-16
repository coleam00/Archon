import { loadArchonEnv } from '@archon/paths/env-loader';

/**
 * Load ~/.archon/.env and <cwd>/.archon/.env into the supplied environment, and
 * return the environment forge plugin processes run with.
 *
 * Inside a run, a token or stored-login redirect the engine set carries the run's
 * identity; neither Archon env file may replace or restore it. An absent key is no
 * opinion, so the env files still supply it (see github-token-policy). Imported only
 * for a workflow identity: CLI startup must not load workflow modules otherwise
 * (check:cli-import-boundary).
 */
export async function loadCliEnv(
  cwd: string,
  options: { env?: NodeJS.ProcessEnv; preserveGithubCredentials?: boolean } = {}
): Promise<NodeJS.ProcessEnv> {
  const env = options.env ?? process.env;
  const runGithubCredentials =
    (options.preserveGithubCredentials ?? Boolean(env.WORKFLOW_ID))
      ? (
          await import('@archon/workflows/utils/github-token-policy')
        ).RUN_GITHUB_IDENTITY_KEYS.flatMap(key => {
          const value = env[key];
          return value === undefined ? [] : [[key, value] as const];
        })
      : [];
  let forgeTrustedEnv: NodeJS.ProcessEnv = {};
  loadArchonEnv(cwd, {
    env,
    afterUserLoad: () => {
      // Forge plugin processes run with the environment as the user scope left it, so
      // the repository's `.archon/.env` can supply a credential (passed separately) but
      // cannot change the environment an executable plugin runs in.
      for (const [key, value] of runGithubCredentials) env[key] = value;
      forgeTrustedEnv = { ...env };
    },
  });
  // gh's stored login is runtime identity, like HOME, and must not be redirected
  // by repo env and then inherited as a run identity by a nested CLI invocation.
  if (forgeTrustedEnv.GH_CONFIG_DIR === undefined) delete env.GH_CONFIG_DIR;
  else env.GH_CONFIG_DIR = forgeTrustedEnv.GH_CONFIG_DIR;
  for (const [key, value] of runGithubCredentials) env[key] = value;
  return forgeTrustedEnv;
}
