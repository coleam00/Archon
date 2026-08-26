import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getArchonTempPath } from '@archon/paths';

import type { NativeTool } from '../../types';

export interface NativeToolsV2Bridge {
  configDir: string;
  configContent: string;
  pluginId: string;
  url: string;
  close: () => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function authorized(header: string | null, expected: string): boolean {
  if (header === null) return false;
  const actualBuffer = Buffer.from(header);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function pluginSource(
  pluginId: string,
  bridgeUrl: string,
  token: string,
  tools: readonly NativeTool[]
): string {
  const definitions = tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input: tool.inputSchema,
  }));
  return `const definitions = ${JSON.stringify(definitions)};

export default {
  id: ${JSON.stringify(pluginId)},
  setup: async (ctx) => {
    await ctx.tool.transform((registry) => {
      for (const definition of definitions) {
        registry.add({
          name: definition.name,
          description: definition.description,
          input: definition.input,
          execute: async (input) => {
            const response = await fetch(${JSON.stringify(bridgeUrl)}, {
              method: "POST",
              headers: {
                authorization: ${JSON.stringify(`Bearer ${token}`)},
                "content-type": "application/json",
              },
              body: JSON.stringify({ name: definition.name, input }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || "Archon native tool failed");
            return { content: result.content };
          },
          options: { codemode: false },
        });
      }
    });
  },
};
`;
}

export async function startNativeToolsV2Bridge(
  nativeTools: readonly NativeTool[]
): Promise<NativeToolsV2Bridge> {
  const tools = new Map<string, NativeTool>();
  for (const tool of nativeTools) {
    if (tools.has(tool.name)) throw new Error(`Duplicate OpenCode native tool '${tool.name}'`);
    tools.set(tool.name, tool);
  }

  const token = randomBytes(32).toString('base64url');
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request): Promise<Response> => {
      if (
        request.method !== 'POST' ||
        new URL(request.url).pathname !== '/tool' ||
        !authorized(request.headers.get('authorization'), `Bearer ${token}`)
      ) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }

      const body: unknown = await request.json().catch(() => undefined);
      if (!isRecord(body) || typeof body.name !== 'string' || !isRecord(body.input)) {
        return Response.json({ error: 'Invalid native tool request' }, { status: 400 });
      }
      const tool = tools.get(body.name);
      if (!tool) return Response.json({ error: 'Unknown native tool' }, { status: 404 });

      try {
        return Response.json({ content: await tool.handler(body.input) });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : 'Native tool failed' },
          { status: 500 }
        );
      }
    },
  });

  const tempRoot = getArchonTempPath();
  let configDir: string;
  try {
    await mkdir(tempRoot, { recursive: true });
    configDir = await mkdtemp(join(tempRoot, 'opencode-native-tools-'));
  } catch (error) {
    server.stop(true);
    throw error;
  }
  const pluginsDir = join(configDir, 'plugins');
  const pluginPath = join(pluginsDir, 'archon-native-tools.ts');
  const pluginId = `archon.native-tools.${randomBytes(8).toString('hex')}`;
  try {
    await mkdir(pluginsDir, { recursive: true });
    await writeFile(
      pluginPath,
      pluginSource(pluginId, `http://127.0.0.1:${server.port}/tool`, token, nativeTools),
      { encoding: 'utf8', mode: 0o600 }
    );
  } catch (error) {
    server.stop(true);
    await rm(configDir, { recursive: true, force: true });
    throw error;
  }

  let closed = false;
  return {
    configDir,
    configContent: JSON.stringify({ plugin: [pluginPath] }),
    pluginId,
    url: `http://127.0.0.1:${server.port}/tool`,
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      server.stop(true);
      await rm(configDir, { recursive: true, force: true });
    },
  };
}
