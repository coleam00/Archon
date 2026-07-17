/**
 * Thin `docker` CLI wrapper for the container isolation backend.
 *
 * Mirrors `@archon/git/exec.ts`: a single `execFile`-based function that shells
 * out to the `docker` binary and normalizes stdout/stderr to strings. We shell
 * the CLI rather than use dockerode because dockerode segfaults Bun on hijacked
 * exec streams (oven-sh/bun#20397) and ignores `socketPath` under Bun
 * (dockerode#747) — and shelling matches this repo's `execFileAsync` philosophy.
 *
 * `DockerRunner` is exported as a type so backends can inject a fake in unit
 * tests (dependency injection, not `mock.module` — see the isolation package's
 * mock-isolation rules).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const promisifiedExecFile = promisify(execFile);

export interface DockerExecOptions {
  /** Milliseconds before the docker invocation is killed. */
  timeout?: number;
  /** Max stdout/stderr bytes buffered before the call rejects. */
  maxBuffer?: number;
  /**
   * Environment for the `docker` CLI process itself (NOT the container). Almost
   * always omit — the CLI needs the host env (DOCKER_HOST, PATH, etc.) to reach
   * the daemon. Container-facing env is delivered via `-e` flags in the args.
   */
  env?: NodeJS.ProcessEnv;
}

export interface DockerExecResult {
  stdout: string;
  stderr: string;
}

/**
 * A `docker <args>` runner. The default is {@link dockerCli}; backends accept a
 * `DockerRunner` so tests can substitute a fake without touching the process.
 */
export type DockerRunner = (
  args: string[],
  options?: DockerExecOptions
) => Promise<DockerExecResult>;

/** Default docker CLI timeout: 60s (image-less runs are fast; pulls are not our path). */
const DOCKER_DEFAULT_TIMEOUT = 60_000;
/** Generous buffer — `docker inspect`/`logs` can be large. */
const DOCKER_DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Run `docker` with the given args. Rejects (like `execFile`) on non-zero exit,
 * with `stdout`/`stderr` attached to the error for the isolation error
 * classifier (`classifyIsolationError`) to map into an actionable message.
 */
export async function dockerCli(
  args: string[],
  options?: DockerExecOptions
): Promise<DockerExecResult> {
  const result = await promisifiedExecFile('docker', args, {
    timeout: options?.timeout ?? DOCKER_DEFAULT_TIMEOUT,
    maxBuffer: options?.maxBuffer ?? DOCKER_DEFAULT_MAX_BUFFER,
    ...(options?.env ? { env: options.env } : {}),
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Verify the Docker daemon is reachable and the runner image is present, BEFORE
 * any volume/container is created — so a missing daemon or image fails fast with
 * an actionable message instead of a half-created environment.
 *
 * Throws a plain `Error` whose message the isolation classifier recognizes
 * (daemon-down / image-missing patterns in `errors.ts`).
 */
export async function dockerPreflight(
  image: string,
  runner: DockerRunner = dockerCli
): Promise<void> {
  // 1. Daemon reachable. `docker version --format {{.Server.Version}}` errors
  //    with "Cannot connect to the Docker daemon" when the daemon is down.
  try {
    await runner(['version', '--format', '{{.Server.Version}}'], { timeout: 10_000 });
  } catch (err) {
    const detail = extractDockerError(err);
    throw new Error(`Cannot connect to the Docker daemon. Is Docker running? (${detail})`);
  }

  // 2. Runner image present locally. We never auto-pull — the image is built
  //    from the in-repo Dockerfile, so a miss means "build it", not "pull it".
  try {
    await runner(['image', 'inspect', image], { timeout: 15_000 });
  } catch (err) {
    const detail = extractDockerError(err);
    throw new Error(
      `No such image: '${image}'. Build the runner image first: ` +
        `docker build -t ${image} -f packages/isolation/docker/runner.Dockerfile packages/isolation/docker (${detail})`
    );
  }
}

/**
 * Pull the best available error text off a rejected `execFile` promise: the
 * child's stderr if present, else the error message. Used to enrich preflight
 * errors and to feed `classifyIsolationError`.
 */
export function extractDockerError(err: unknown): string {
  const e = err as Error & { stderr?: string; stdout?: string };
  const stderr = (e.stderr ?? '').trim();
  if (stderr) return stderr.split('\n')[0] ?? stderr;
  return (e.message ?? String(err)).split('\n')[0] ?? String(err);
}
