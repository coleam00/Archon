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
    expect(isKnownIsolationError(error)).toBe(false);
    expect(classifyIsolationError(error)).toContain(error.message);
  }
);

test.skipIf(process.platform === 'win32')(
  'dockerCli classifies a real process timeout and preserves its cause',
  async () => {
    const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'docker-cli-')));
    await writeFile(join(root, 'docker'), '#!/bin/sh\nexec /bin/sleep 30\n', { mode: 0o755 });

    const error = await dockerCli(['version'], {
      timeout: 100,
      env: { ...process.env, PATH: root },
    }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(IsolationFailure);
    if (!(error instanceof IsolationFailure)) throw new Error('expected isolation failure');
    expect(error.kind).toBe('timeout');
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.cause).toMatchObject({ code: null, killed: true, signal: 'SIGTERM' });
    expect(error.message).toContain('docker version');
    expect(isKnownIsolationError(error)).toBe(true);
    expect(classifyIsolationError(error)).toBe(
      '**Error:** Timed out creating workspace. Git repository may be slow or unavailable.'
    );
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

  test('an unreachable daemon keeps the start-Docker remedy and its evidence', async () => {
    const runner: DockerRunner = async () => {
      const err = new Error('Command failed') as Error & { stderr?: string };
      err.stderr = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock';
      throw new IsolationFailure('unclassified', extractDockerError(err), err);
    };
    const error = await dockerPreflight('archon-runner:test', runner).catch(
      (error: unknown) => error
    );
    expect(error).toBeInstanceOf(IsolationFailure);
    if (!(error instanceof IsolationFailure)) throw new Error('expected isolation failure');
    expect(error.kind).toBe('docker_unreachable');
    expect(error.message).toContain('unix:///var/run/docker.sock');
    expect(classifyIsolationError(error)).toBe(
      '**Error:** Cannot connect to the Docker daemon. Start Docker (Docker Desktop or ' +
        '`systemctl start docker`) and retry, or run without `--container`.'
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

  test('a missing image keeps the build remedy', async () => {
    const runner: DockerRunner = async args => {
      if (args[0] === 'version') return { stdout: '28.2.2', stderr: '' };
      const err = new Error('Command failed') as Error & { stderr?: string };
      err.stderr = 'Error: No such image: archon-runner:test';
      throw new IsolationFailure('unclassified', extractDockerError(err), err);
    };
    const error = await dockerPreflight('archon-runner:test', runner).catch(
      (error: unknown) => error
    );
    expect(error).toBeInstanceOf(IsolationFailure);
    if (!(error instanceof IsolationFailure)) throw new Error('expected isolation failure');
    expect(error.kind).toBe('runner_image_missing');
    expect(error.message).toContain("No such image: 'archon-runner:test'");
    expect(error.message).toContain('docker build');
    expect(classifyIsolationError(error)).toBe(
      '**Error:** The Archon runner image is missing. Build it with ' +
        '`bun run build:runner-image` (tags `archon-runner:<version>` + `:latest`), ' +
        'or build your configured `container.image` from ' +
        '`packages/isolation/docker/runner.Dockerfile`.'
    );
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

test.each([
  ['timeout', new IsolationFailure('timeout', 'version timed out')],
  [
    'unclassified exit',
    new IsolationFailure(
      'unclassified',
      'version failed',
      Object.assign(new Error('version failed'), { code: 1, stderr: 'original stderr' })
    ),
  ],
  [
    'spawn permission',
    new IsolationFailure(
      'unclassified',
      'version spawn denied',
      Object.assign(new Error('version spawn denied'), { code: 'EACCES' })
    ),
  ],
])('any version preflight failure (%s) reads as an unreachable daemon', async (_, failure) => {
  const error = await dockerPreflight('image', async () => {
    throw failure;
  }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(IsolationFailure);
  if (!(error instanceof IsolationFailure)) throw new Error('expected isolation failure');
  expect(error.kind).toBe('docker_unreachable');
  expect(error.cause).toBe(failure);
  expect(isKnownIsolationError(error)).toBe(true);
  expect(classifyIsolationError(error)).toBe(
    '**Error:** Cannot connect to the Docker daemon. Start Docker (Docker Desktop or ' +
      '`systemctl start docker`) and retry, or run without `--container`.'
  );
});

test.each([
  ['timeout', new IsolationFailure('timeout', 'image inspection timed out')],
  [
    'unclassified exit',
    new IsolationFailure(
      'unclassified',
      'image inspect failed',
      Object.assign(new Error('image inspect failed'), { code: 1, stderr: 'original stderr' })
    ),
  ],
])('any image inspection failure (%s) reads as a missing runner image', async (_, failure) => {
  const runner: DockerRunner = async args => {
    if (args[0] === 'version') return { stdout: '28', stderr: '' };
    throw failure;
  };
  const error = await dockerPreflight('image', runner).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(IsolationFailure);
  if (!(error instanceof IsolationFailure)) throw new Error('expected isolation failure');
  expect(error.kind).toBe('runner_image_missing');
  expect(error.cause).toBe(failure);
  expect(isKnownIsolationError(error)).toBe(true);
  expect(classifyIsolationError(error)).toContain('The Archon runner image is missing');
});

test('dockerCli propagates invalid process options as programming errors', async () => {
  const error = await dockerCli(['version'], { timeout: -1 }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(RangeError);
  if (!(error instanceof Error)) throw new Error('expected programming error');
  expect(isKnownIsolationError(error)).toBe(false);
});
