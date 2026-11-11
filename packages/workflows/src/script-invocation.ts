import type { ScriptRuntime } from './script-discovery';

export function scriptInvocation(
  runtime: ScriptRuntime,
  source: { kind: 'inline'; code: string } | { kind: 'file'; path: string },
  deps: readonly string[] = [],
  /** A Bun preload file: `scriptApiPreload`, which provides the `archon:script` module. */
  preload?: string
): { command: ScriptRuntime; args: string[]; input?: string } {
  if (runtime === 'bun') {
    // Preserve Archon's environment boundary when Bun runs in a repository with .env.
    // Bun reads --preload only where it is placed here: before `-`, and after `run`.
    const preloadFlag = preload === undefined ? [] : [`--preload=${preload}`];
    if (source.kind === 'inline') {
      return {
        command: runtime,
        args: ['--no-env-file', ...preloadFlag, '-'],
        input: source.code,
      };
    }
    return {
      command: runtime,
      args: ['--no-env-file', 'run', ...preloadFlag, source.path],
    };
  }
  return {
    command: runtime,
    args: [
      'run',
      ...deps.flatMap(dep => ['--with', dep]),
      ...(source.kind === 'inline' ? ['python', '-c', source.code] : [source.path]),
    ],
  };
}
