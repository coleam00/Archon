// @archon-test-isolated
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
    });
  });

  test('missing diagnostics list every attempted location in order', async () => {
    const result = await resolveMcpPath('absent.json', checkout, home);
    expect(result).toEqual({
      kind: 'missing',
      attemptedPaths: [join(checkout, 'absent.json'), join(home, 'absent.json')],
    });
    if (result.kind !== 'missing') throw new Error('Expected missing config');
    expect(missingMcpConfigMessage('absent.json', result.attemptedPaths)).toBe(
      `MCP config file not found: 'absent.json'. Tried: ${join(checkout, 'absent.json')}, ${join(home, 'absent.json')}`
    );
  });

  test('a missing candidate guard failure is returned with its original cause', async () => {
    const candidates = [join(checkout, 'servers.json'), join(home, 'servers.json')];
    for (const [index, guardedPath] of candidates.entries()) {
      const sentinel = new Error('Verified captured config disappeared');
      const missing: { path: string; error: unknown }[] = [];
      const result = await resolveMcpPath('servers.json', checkout, home, (path, error) => {
        missing.push({ path, error });
        if (path === guardedPath) throw sentinel;
      });

      expect(result).toEqual({ kind: 'read_error', path: guardedPath, error: sentinel });
      if (result.kind !== 'read_error') throw new Error('Expected guard failure');
      expect(result.error).toBe(sentinel);
      expect(missing.map(({ path }) => path)).toEqual(candidates.slice(0, index + 1));
      for (const { error } of missing) expect(error).toMatchObject({ code: 'ENOENT' });
    }
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
    });
    if (result.kind !== 'read_error') throw new Error('Expected read failure');
    expect(result.error).toMatchObject({ code: 'EISDIR' });
  });
});
