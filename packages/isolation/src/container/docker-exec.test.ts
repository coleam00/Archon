import { describe, test, expect } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { dockerCli, dockerPreflight, extractDockerError, type DockerRunner } from './docker-exec';
import { IsolationFailure, classifyIsolationError, isKnownIsolationError } from '../errors';

const trackTempRoot = trackTempRoots();

// Windows execFile requires a native executable; it cannot launch this shell fixture.
test.skipIf(process.platform === 'win32')(
  'dockerCli wraps a real process failure with its operation and original evidence',
  async () => {
    const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'docker-cli-')));
    const stderr = 'permission denied: No such image: fix/timeout-retry\noriginal stderr\n';
    await writeFile(
      join(root, 'docker'),
      `#!/bin/sh\nprintf '%s\\n' 'permission denied: No such image: fix/timeout-retry' 'original stderr' >&2\nexit 23\n`,
      { mode: 0o755 }
    );

    const error = await dockerCli(['image', 'inspect', 'fix/timeout-retry'], {
      env: { ...process.env, PATH: root },
    }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(IsolationFailure);
    if (!(error instanceof IsolationFailure)) throw new Error('expected isolation failure');
    expect(error.kind).toBe('unclassified');
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.cause).toMatchObject({ code: 23, stderr });
    expect(error.message).toContain('docker image inspect failed');
    expect(error.message).toContain(stderr);
    expect(error.message).toContain('exit code 23');
    expect(isKnownIsolationError(error)).toBe(true);
    expect(classifyIsolationError(error)).toBe(`**Error:** ${error.message}`);
  }
);

describe('dockerPreflight', () => {
  test('resolves when daemon reachable and image present', async () => {
    const calls: string[][] = [];
    const runner: DockerRunner = async args => {
      calls.push(args);
      return { stdout: '28.2.2', stderr: '' };
    };
    await dockerPreflight('archon-runner:test', runner);
    expect(calls[0]).toEqual(['version', '--format', '{{.Server.Version}}']);
    expect(calls[1]).toEqual(['image', 'inspect', 'archon-runner:test']);
  });

  test('quotes an unclassified version failure', async () => {
    const runner: DockerRunner = async () => {
      const err = new Error('Command failed') as Error & { stderr?: string };
      err.stderr = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock';
      throw new IsolationFailure('unclassified', extractDockerError(err), err);
    };
    await expect(dockerPreflight('archon-runner:test', runner)).rejects.toThrow(
      /docker version failed/
    );
  });

  test('daemon-down error names the dockerized-Archon case when ARCHON_DOCKER=true', async () => {
    const prev = process.env.ARCHON_DOCKER;
    process.env.ARCHON_DOCKER = 'true';
    try {
      const runner: DockerRunner = async () => {
        const err = new Error('Command failed') as Error & { stderr?: string };
        err.stderr = 'Cannot connect to the Docker daemon';
        throw new IsolationFailure('unclassified', extractDockerError(err), err);
      };
      await expect(dockerPreflight('archon-runner:test', runner)).rejects.toThrow(
        /running inside Docker.*--container backend is unavailable/s
      );
    } finally {
      if (prev === undefined) delete process.env.ARCHON_DOCKER;
      else process.env.ARCHON_DOCKER = prev;
    }
  });

  test('throws an image-missing error naming the build command', async () => {
    const runner: DockerRunner = async args => {
      if (args[0] === 'version') return { stdout: '28.2.2', stderr: '' };
      const err = new Error('Command failed') as Error & { stderr?: string };
      err.stderr = 'Error: No such image: archon-runner:test';
      throw new IsolationFailure('unclassified', extractDockerError(err), err);
    };
    const p = dockerPreflight('archon-runner:test', runner);
    await expect(p).rejects.toThrow(/Cannot inspect image 'archon-runner:test'/);
    await expect(p).rejects.toThrow(/docker build/);
  });
});

describe('extractDockerError', () => {
  test('preserves full stderr', () => {
    const err = new Error('wrapper message') as Error & { stderr?: string };
    err.stderr = 'real docker error\nsecond line';
    expect(extractDockerError(err)).toBe('real docker error\nsecond line');
  });

  test('falls back to the error message when no stderr', () => {
    expect(extractDockerError(new Error('boom\ntrace'))).toBe('boom\ntrace');
  });
});

describe('Docker failure classification', () => {
  test('an image inspection failure stays unclassified with its full evidence', async () => {
    const stderr = 'permission denied\nNo such image: fix/timeout-retry';
    const cause = Object.assign(new Error('image inspect failed'), { code: 1, stderr });
    const runner: DockerRunner = async args => {
      if (args[0] === 'version') return { stdout: '28', stderr: '' };
      throw new IsolationFailure('unclassified', extractDockerError(cause), cause);
    };
    const error = await dockerPreflight('fix/timeout-retry', runner).catch(
      (error: unknown) => error
    );
    if (!(error instanceof Error)) throw new Error('expected Docker failure');
    expect(error.cause).toBeInstanceOf(IsolationFailure);
    if (!(error.cause instanceof IsolationFailure)) throw new Error('expected Docker failure');
    expect(error.cause.cause).toBe(cause);
    expect(isKnownIsolationError(error)).toBe(true);
    expect(classifyIsolationError(error)).toContain(stderr);
    expect(classifyIsolationError(error)).toContain('exit code 1');
    expect(classifyIsolationError(error)).toContain('Cannot inspect image');
    expect(classifyIsolationError(error)).not.toContain('Timed out');
    expect(classifyIsolationError(error)).not.toContain('runner image is missing');
  });
});

test('version preflight preserves typed timeout', async () => {
  const failure = new IsolationFailure('timeout', 'version timed out');
  const error = await dockerPreflight('image', async () => {
    throw failure;
  }).catch((error: unknown) => error);
  expect(error).toBe(failure);
  expect(classifyIsolationError(failure)).toContain('Timed out');
});

test('version preflight quotes unclassified exit evidence without guessing daemon status', async () => {
  const cause = Object.assign(new Error('version failed'), {
    code: 1,
    stderr: 'timeout: Cannot connect to the Docker daemon\noriginal stderr',
  });
  const error = await dockerPreflight('image', async () => {
    throw new IsolationFailure('unclassified', extractDockerError(cause), cause);
  }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(IsolationFailure);
  if (!(error instanceof IsolationFailure)) throw new Error('expected isolation failure');
  expect(error.kind).toBe('unclassified');
  expect(error.cause).toBeInstanceOf(IsolationFailure);
  if (!(error.cause instanceof IsolationFailure)) throw new Error('expected Docker failure');
  expect(error.cause.cause).toBe(cause);
  expect(classifyIsolationError(error)).toContain('docker version');
  expect(classifyIsolationError(error)).toContain('exit code 1');
  expect(classifyIsolationError(error)).toContain(cause.stderr);
  expect(classifyIsolationError(error)).not.toContain('Timed out creating workspace');
});

test('version preflight preserves structured permission guidance', async () => {
  const cause = Object.assign(new Error('version spawn denied'), { code: 'EACCES' });
  const error = await dockerPreflight('image', async () => {
    throw new IsolationFailure('unclassified', extractDockerError(cause), cause);
  }).catch((error: unknown) => error);
  if (!(error instanceof Error)) throw new Error('expected error');
  expect(error.cause).toBeInstanceOf(IsolationFailure);
  if (!(error.cause instanceof IsolationFailure)) throw new Error('expected Docker failure');
  expect(error.cause.cause).toBe(cause);
  expect(classifyIsolationError(error)).toContain('Permission denied');
});

test('image preflight preserves typed timeout without build advice', async () => {
  const failure = new IsolationFailure('timeout', 'image inspection timed out');
  const runner: DockerRunner = async args => {
    if (args[0] === 'version') return { stdout: '28', stderr: '' };
    throw failure;
  };
  const error = await dockerPreflight('image', runner).catch((error: unknown) => error);
  expect(error).toBe(failure);
  if (!(error instanceof IsolationFailure)) throw new Error('expected isolation failure');
  expect(error.kind).toBe('timeout');
  expect(error.message).toBe('image inspection timed out');
  expect(classifyIsolationError(error)).toContain('Timed out');
  expect(classifyIsolationError(error)).not.toContain('docker build');
});

test('dockerCli propagates invalid process options as programming errors', async () => {
  const error = await dockerCli(['version'], { timeout: -1 }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(RangeError);
  if (!(error instanceof Error)) throw new Error('expected programming error');
  expect(isKnownIsolationError(error)).toBe(false);
});
