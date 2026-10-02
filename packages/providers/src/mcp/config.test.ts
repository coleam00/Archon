import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fsPromises from 'fs/promises';
import { tmpdir } from 'os';
import { ClassifiedProviderError } from '../shared/failure';
import { loadMcpConfig } from './config';

async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected loadMcpConfig to throw');
}

describe('loadMcpConfig failure classes', () => {
  afterEach(() => {
    // Restore any readFile spy between cases.
    (fsPromises.readFile as { mockRestore?: () => void }).mockRestore?.();
  });

  test.each([
    ['a missing file', 'does-not-exist.mcp.json'],
    ['a directory', tmpdir()],
  ])('%s is misconfigured', async (_label, path) => {
    const error = await thrownBy(loadMcpConfig(path, process.cwd()));
    expect(error).toBeInstanceOf(ClassifiedProviderError);
    expect((error as ClassifiedProviderError).failureClass).toBe('misconfigured');
  });

  test('a read error that can pass is not classified', async () => {
    spyOn(fsPromises, 'readFile').mockRejectedValue(
      Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' })
    );
    const error = await thrownBy(loadMcpConfig('servers.mcp.json', process.cwd()));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ClassifiedProviderError);
  });
});
