import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';
import { resolveMcpPath, missingMcpConfigMessage } from './mcp-path';

describe('MCP path selection', () => {
  let root: string;
  let checkout: string;
  let home: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mcp-path-'));
    checkout = join(root, 'checkout');
    home = join(root, 'home');
    await mkdir(checkout);
    await mkdir(home);
  });
  afterEach(async () => removeTempTree(root));

  test('checkout wins, including malformed JSON, without reading home', async () => {
    await writeFile(join(home, 'servers.json'), '{"home":{}}');
    for (const content of ['{"checkout":{}}', '{broken']) {
      await writeFile(join(checkout, 'servers.json'), content);
      expect(await resolveMcpPath('servers.json', checkout, home)).toEqual({
        kind: 'found',
        path: join(checkout, 'servers.json'),
        content,
        attemptedPaths: [join(checkout, 'servers.json')],
      });
    }
  });

  test('only an eligible declaration falls back to its YAML directory', async () => {
    await writeFile(join(home, 'servers.json'), '{"home":{}}');
    expect(await resolveMcpPath('servers.json', checkout)).toEqual({
      kind: 'missing',
      attemptedPaths: [join(checkout, 'servers.json')],
    });
    expect(await resolveMcpPath('servers.json', checkout, home)).toEqual({
      kind: 'found',
      path: join(home, 'servers.json'),
      content: '{"home":{}}',
      attemptedPaths: [join(checkout, 'servers.json'), join(home, 'servers.json')],
    });
  });

  test('missing diagnostics list every attempted location in order', async () => {
    const result = await resolveMcpPath('absent.json', checkout, home);
    expect(result).toEqual({
      kind: 'missing',
      attemptedPaths: [join(checkout, 'absent.json'), join(home, 'absent.json')],
    });
    expect(missingMcpConfigMessage('absent.json', result.attemptedPaths)).toBe(
      `MCP config file not found: 'absent.json'. Tried: ${join(checkout, 'absent.json')}, ${join(home, 'absent.json')}`
    );
  });

  test('absolute declarations bypass both bases and identical candidates are tried once', async () => {
    const absolute = join(root, 'absent.json');
    expect(await resolveMcpPath(absolute, checkout, home)).toEqual({
      kind: 'missing',
      attemptedPaths: [absolute],
    });
    expect(await resolveMcpPath('absent.json', checkout, checkout)).toEqual({
      kind: 'missing',
      attemptedPaths: [join(checkout, 'absent.json')],
    });
  });

  test('a directory at the checkout candidate fails reading without fallback', async () => {
    await mkdir(join(checkout, 'servers.json'));
    await writeFile(join(home, 'servers.json'), '{}');
    const result = await resolveMcpPath('servers.json', checkout, home);
    expect(result).toMatchObject({
      kind: 'read_error',
      path: join(checkout, 'servers.json'),
      attemptedPaths: [join(checkout, 'servers.json')],
    });
    if (result.kind !== 'read_error') throw new Error('Expected read failure');
    expect(result.error).toMatchObject({ code: 'EISDIR' });
  });
});
