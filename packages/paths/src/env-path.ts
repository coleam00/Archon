type Env = Readonly<Record<string, string | undefined>>;

/**
 * The key that holds the executable search path in `env`. Windows env names are
 * case-insensitive and Task Scheduler and cmd spell it `Path`, but a copied env object is
 * case-sensitive, so `env.PATH` misses it. An exact `PATH` wins when both exist. The match
 * is case-insensitive on every platform: a POSIX `Path` variable is not a real case.
 */
export function envPathKey(env: Env): string {
  if (env.PATH !== undefined) return 'PATH';
  return Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
}

/** The executable search path in `env`, however its key is cased. */
export function envPath(env: Env): string | undefined {
  return env[envPathKey(env)];
}
