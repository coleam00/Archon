// @archon-test-isolated
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import * as paths from '@archon/paths';
import type { PluginEnvironment } from './plugin';
const replacePlugin = mock(async (_ref: string, _env: PluginEnvironment) => undefined);
mock.module('./plugin', () => ({ replacePlugin }));
mock.module('@archon/paths', () => ({ ...paths, BUNDLED_IS_BINARY: true }));
const { providerCommand } = await import('./provider');
const env = { pluginsDir: '/unused', projectDir: '/unused', archonVersion: '0.13.0' };
const error = spyOn(console, 'error').mockImplementation(() => undefined);
afterEach(() => {
  replacePlugin.mockClear();
  error.mockClear();
});

test('installs each requested first-party provider pinned to this CLI version', async () => {
  expect(await providerCommand('install', ['codex', 'pi'], env)).toBe(0);
  expect(replacePlugin.mock.calls).toEqual([
    ['coleam00/Archon/plugins/provider-codex@v0.13.0', env],
    ['coleam00/Archon/plugins/provider-pi@v0.13.0', env],
  ]);
});
test('invalid ids and command arity fail before any installation', async () => {
  for (const [command, ids] of [
    ['install', ['codex', 'third-party']],
    ['install', []],
    ['remove', ['pi']],
  ] as const) {
    expect(await providerCommand(command, ids, env)).toBe(1);
  }
  expect(replacePlugin).not.toHaveBeenCalled();
});
test('source checkouts refuse installation', async () => {
  mock.module('@archon/paths', () => ({ ...paths, BUNDLED_IS_BINARY: false }));
  expect(await providerCommand('install', ['claude'], env)).toBe(1);
  expect(error.mock.calls.flat().join('\n')).toContain(
    'Source checkouts run maintained providers from source'
  );
  expect(replacePlugin).not.toHaveBeenCalled();
});
