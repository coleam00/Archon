import type { ScriptRuntime } from './script-discovery';

export function scriptInvocation(
  runtime: ScriptRuntime,
  source: { kind: 'inline'; code: string } | { kind: 'file'; path: string },
  deps: readonly string[] = []
): { command: ScriptRuntime; args: string[] } {
  if (runtime === 'bun') {
    // Preserve Archon's environment boundary when Bun runs in a repository with .env.
    return {
      command: runtime,
      args: [
        '--no-env-file',
        ...(source.kind === 'inline' ? ['-e', source.code] : ['run', source.path]),
      ],
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
