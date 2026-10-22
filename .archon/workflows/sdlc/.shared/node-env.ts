/** The node's environment without the run contract: what a project command should see. */
export function projectEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const runKeys: unknown = JSON.parse(env.ARCHON_RUN_ENV_KEYS ?? 'null');
  if (!Array.isArray(runKeys) || !runKeys.every((key: unknown) => typeof key === 'string')) {
    throw new Error('ARCHON_RUN_ENV_KEYS must be a JSON array of run environment keys');
  }
  const contract = new Set(runKeys);
  return Object.fromEntries(Object.entries(env).filter(([key]) => !contract.has(key)));
}
