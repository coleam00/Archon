import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_ARTIFACTS_ENGINE_SUBDIR } from '@archon/paths';
import { scriptApiPreload } from './script-api/preload';
import type { ScriptRuntime } from './script-discovery';

export function scriptInvocation(
  runtime: ScriptRuntime,
  source: { kind: 'inline'; code: string } | { kind: 'file'; path: string },
  deps: readonly string[] = [],
  /** The run's artifact directory; the engine keeps the files the runtime needs in its part of it. */
  artifactsDir: string
): { command: ScriptRuntime; args: string[]; input?: string } {
  if (runtime === 'bun') {
    // Preserve Archon's environment boundary when Bun runs in a repository with .env.
    // Bun reads --preload only where it is placed here: before `-`, and after `run`.
    const preloadFlag = `--preload=${scriptApiPreload(artifactsDir)}`;
    if (source.kind === 'inline') {
      return {
        command: runtime,
        args: ['--no-env-file', preloadFlag, '-'],
        input: source.code,
      };
    }
    return {
      command: runtime,
      args: ['--no-env-file', 'run', preloadFlag, source.path],
    };
  }
  // Keep the checkout's uv project out of the script. --project moves project, config and
  // .python-version discovery from the checkout to an empty engine-owned directory, so the
  // checkout's uv.lock, dependencies, uv.toml, [tool.uv] and Python pin do not apply.
  // --no-project stops uv walking up from that directory into an ancestor's project.
  // --isolated runs in a fresh environment: without it uv still finds the checkout's .venv
  // from the working directory and makes its packages importable, even with --with. The
  // user's own uv config and the script's working directory stay as they are.
  return {
    command: runtime,
    args: [
      'run',
      '--no-project',
      '--isolated',
      '--project',
      uvProjectDir(artifactsDir),
      ...deps.flatMap(dep => ['--with', dep]),
      ...(source.kind === 'inline' ? ['python', '-c', source.code] : [source.path]),
    ],
  };
}

/** uv refuses a --project directory that does not exist. */
function uvProjectDir(artifactsDir: string): string {
  const dir = join(artifactsDir, RUN_ARTIFACTS_ENGINE_SUBDIR, 'uv-project');
  mkdirSync(dir, { recursive: true });
  return dir;
}
