import { expect, mock, spyOn, test } from 'bun:test';

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { startNativeToolsV2Bridge } from './native-tools-v2';

interface GeneratedToolDefinition {
  name: string;
  description: string;
  input: Record<string, unknown>;
  options: { codemode: boolean };
  execute: (input: Record<string, unknown>) => Promise<{ content: string }>;
}

interface GeneratedPlugin {
  id: string;
  setup: (context: {
    tool: {
      transform: (
        callback: (registry: { add: (definition: GeneratedToolDefinition) => void }) => void
      ) => Promise<void>;
    };
  }) => Promise<void>;
}

test('generated plugin enforces bearer auth and preserves handler failures', async () => {
  const handler = mock(async (input: Record<string, unknown>) => `handled:${input.action}`);
  const bridge = await startNativeToolsV2Bridge([
    {
      name: 'manage_run',
      description: 'Manage workflow runs',
      inputSchema: {
        type: 'object',
        properties: { action: { type: 'string' } },
        required: ['action'],
      },
      handler,
    },
  ]);

  let definition: GeneratedToolDefinition | undefined;
  try {
    const path = join(bridge.configDir, 'plugins', 'archon-native-tools.ts');
    const loaded = (await import(`${pathToFileURL(path).href}?test`)) as {
      default: GeneratedPlugin;
    };
    expect(loaded.default.id).toBe(bridge.pluginId);
    await loaded.default.setup({
      tool: {
        transform: async callback => {
          callback({
            add: added => {
              definition = added;
            },
          });
        },
      },
    });

    const request = { name: 'manage_run', input: { action: 'list' } };
    const missing = await fetch(bridge.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    const wrong = await fetch(bridge.url, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();

    expect(definition).toMatchObject({
      name: 'manage_run',
      options: { codemode: false },
    });
    await expect(definition!.execute({ action: 'list' })).resolves.toEqual({
      content: 'handled:list',
    });
    expect(handler).toHaveBeenCalledWith({ action: 'list' });

    const sentinel = new Error('handler exploded');
    handler.mockImplementationOnce(async (): Promise<never> => {
      throw sentinel;
    });
    const realFetch = globalThis.fetch;
    const statuses: number[] = [];
    const interceptedFetch = (async (...args: Parameters<typeof fetch>) => {
      const response = await realFetch(...args);
      statuses.push(response.status);
      return response;
    }) as typeof fetch;
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(interceptedFetch);
    try {
      await expect(definition!.execute({ action: 'start' })).rejects.toThrow(sentinel.message);
      expect(statuses.at(-1)).toBe(500);
    } finally {
      fetchSpy.mockRestore();
    }
  } finally {
    await bridge.close();
  }

  await expect(stat(bridge.configDir)).rejects.toMatchObject({ code: 'ENOENT' });
});
