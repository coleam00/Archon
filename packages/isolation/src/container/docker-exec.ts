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

import { IsolationFailure } from '../errors';
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
 * Run `docker` with the given args. Process failures become IsolationFailure
 * with the original execFile error (stdout, stderr, and exit code) as cause.
 */
export async function dockerCli(
  args: string[],
  options?: DockerExecOptions
): Promise<DockerExecResult> {
  const result = await promisifiedExecFile('docker', args, {
    timeout: options?.timeout ?? DOCKER_DEFAULT_TIMEOUT,
    maxBuffer: options?.maxBuffer ?? DOCKER_DEFAULT_MAX_BUFFER,
    ...(options?.env ? { env: options.env } : {}),
  }).catch((cause: unknown) => {
    if (
      !(cause instanceof Error) ||
      !('code' in cause) ||
      !(typeof cause.code === 'number' || typeof cause.code === 'string' || cause.code === null)
    )
      throw cause;
    const timedOut = 'killed' in cause && cause.killed === true && cause.code === null;
    throw new IsolationFailure(
      timedOut ? 'timeout' : 'unclassified',
      `docker ${args[0] ?? ''} ${args[1] ?? ''} failed: ${extractDockerError(cause)}`,
      cause
    );
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
 */
export async function dockerPreflight(
  image: string,
  runner: DockerRunner = dockerCli
): Promise<void> {
  // 1. Daemon reachable. `docker version --format {{.Server.Version}}` fails
  //    whenever the CLI cannot get an answer from the daemon.
  try {
    await runner(['version', '--format', '{{.Server.Version}}'], { timeout: 10_000 });
  } catch (err) {
    if (!(err instanceof IsolationFailure)) throw err;
    const detail = extractDockerError(err);
    // When Archon itself runs in Docker (the compose stack), the app image ships
    // no `docker` CLI and the daemon socket is deliberately NOT mounted — so
    // `--container` cannot work here. Say so instead of the misleading generic
    // "is Docker running?" (see deployment/docker.md; the socket is root-equivalent).
    const dockerizedHint =
      process.env.ARCHON_DOCKER === 'true'
        ? ' Archon is running inside Docker, which does not mount the Docker daemon socket — ' +
          'the --container backend is unavailable in a dockerized deploy. Run Archon directly ' +
          'on the host, or see deployment/docker.md.'
        : '';
    throw new IsolationFailure(
      'docker_unreachable',
      `Cannot connect to the Docker daemon. Is Docker running?${dockerizedHint} (${detail})`,
      err
    );
  }

  // 2. Runner image present locally. We never auto-pull — the image is built
  //    from the in-repo Dockerfile, so a miss means "build it", not "pull it".
  try {
    await runner(['image', 'inspect', image], { timeout: 15_000 });
  } catch (err) {
    if (!(err instanceof IsolationFailure)) throw err;
    const detail = extractDockerError(err);
    throw new IsolationFailure(
      'runner_image_missing',
      `No such image: '${image}'. Build the runner image first: ` +
        `docker build -t ${image} -f packages/isolation/docker/runner.Dockerfile packages/isolation/docker (${detail})`,
      err
    );
  }
}

/**
 * Pull the best available error text off a rejected `execFile` promise: the
 * child's full stderr if present, else the error message.
 */
export function extractDockerError(err: unknown): string {
  const e = err as Error & { stderr?: string; stdout?: string; code?: string | number };
  const stderr = e.stderr ?? '';
  const detail = stderr || e.message || String(err);
  return typeof e.code === 'number' ? `${detail} (exit code ${e.code})` : detail;
}
