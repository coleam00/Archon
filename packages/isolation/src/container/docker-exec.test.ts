import { describe, test, expect } from 'bun:test';
import { dockerPreflight, extractDockerError, type DockerRunner } from './docker-exec';
import { classifyIsolationError } from '../errors';

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

  test('throws a daemon-down error when version fails', async () => {
    const runner: DockerRunner = async () => {
      const err = new Error('Command failed') as Error & { stderr?: string };
      err.stderr = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock';
      throw err;
    };
    await expect(dockerPreflight('archon-runner:test', runner)).rejects.toThrow(
      /Cannot connect to the Docker daemon/
    );
  });

  test('throws an image-missing error naming the build command', async () => {
    const runner: DockerRunner = async args => {
      if (args[0] === 'version') return { stdout: '28.2.2', stderr: '' };
      const err = new Error('Command failed') as Error & { stderr?: string };
      err.stderr = 'Error: No such image: archon-runner:test';
      throw err;
    };
    const p = dockerPreflight('archon-runner:test', runner);
    await expect(p).rejects.toThrow(/No such image: 'archon-runner:test'/);
    await expect(p).rejects.toThrow(/docker build/);
  });
});

describe('extractDockerError', () => {
  test('prefers the first stderr line', () => {
    const err = new Error('wrapper message') as Error & { stderr?: string };
    err.stderr = 'real docker error\nsecond line';
    expect(extractDockerError(err)).toBe('real docker error');
  });

  test('falls back to the error message when no stderr', () => {
    expect(extractDockerError(new Error('boom\ntrace'))).toBe('boom');
  });
});

describe('classifyIsolationError — docker patterns', () => {
  test('daemon-down maps to an actionable message', () => {
    const err = new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock');
    expect(classifyIsolationError(err)).toMatch(/Docker daemon/);
    expect(classifyIsolationError(err)).toMatch(/Start Docker/);
  });

  test('image-missing maps to a build instruction', () => {
    const err = new Error("No such image: 'archon-runner:test'");
    expect(classifyIsolationError(err)).toMatch(/runner image is missing/);
    expect(classifyIsolationError(err)).toMatch(/docker build/);
  });

  test('docker permission maps to the docker-group hint', () => {
    const err = new Error('permission denied while trying to connect to the Docker daemon socket');
    expect(classifyIsolationError(err)).toMatch(/docker.*group/i);
  });
});
