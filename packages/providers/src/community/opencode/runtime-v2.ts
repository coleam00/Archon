import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { OpenCode, type OpenCodeClient } from '@opencode-ai/client';
import type { Endpoint } from '@opencode-ai/client/service';

import type { NativeTool } from '../../types';

import { startNativeToolsV2Bridge } from './native-tools-v2';

export const OPENCODE_V2_VERSION = '0.0.0-beta-17963';

export interface V2Runtime {
  client: OpenCodeClient;
  endpoint: Endpoint;
  release: () => Promise<void>;
}

async function resolveOpencodeV2Binary(): Promise<string> {
  try {
    const packageJson = Bun.resolveSync('@opencode-ai/cli/package.json', import.meta.dir);
    const packagedBinary = join(dirname(packageJson), 'bin', 'opencode2.exe');
    if ((await stat(packagedBinary)).isFile()) return packagedBinary;
  } catch {
    // Compiled installs use an operator-installed CLI from PATH.
  }

  const shim = Bun.which('opencode2');
  if (!shim) {
    throw new Error(
      `OpenCode V2 ${OPENCODE_V2_VERSION} is required. Install @opencode-ai/cli@${OPENCODE_V2_VERSION}.`
    );
  }
  if (process.platform !== 'win32' || shim.toLowerCase().endsWith('.exe')) return shim;

  const executable = join(
    dirname(shim),
    'node_modules',
    '@opencode-ai',
    'cli',
    'bin',
    'opencode2.exe'
  );
  const executableInfo = await stat(executable).catch((error: unknown): undefined => {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });
  if (executableInfo?.isFile()) return executable;
  throw new Error(`OpenCode V2 executable not found behind npm shim: ${shim}`);
}

async function assertMatchingVersion(binary: string, signal?: AbortSignal): Promise<void> {
  const versionSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
    : AbortSignal.timeout(5000);
  const child = Bun.spawn([binary, '--version'], {
    stdout: 'pipe',
    stderr: 'pipe',
    signal: versionSignal,
  });
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  const version = stdout.trim().replace(/^opencode2\s+v/, '');
  if (exitCode !== 0 || version !== OPENCODE_V2_VERSION) {
    throw new Error(
      `OpenCode V2 CLI version mismatch: expected ${OPENCODE_V2_VERSION}, found ${version || 'unknown'}. ` +
        `Install @opencode-ai/cli@${OPENCODE_V2_VERSION}.`
    );
  }
}

function abortError(): Error {
  return new Error('OpenCode V2 runtime startup aborted');
}

async function readEndpoint(stdout: ReadableStream<Uint8Array>): Promise<Endpoint> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (!buffer.includes('\n')) {
      const next = await reader.read();
      if (next.done) throw new Error('OpenCode V2 service exited before reporting its URL');
      buffer += decoder.decode(next.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }

  const parsed: unknown = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
  if (typeof parsed !== 'object' || parsed === null || !('url' in parsed)) {
    throw new Error('OpenCode V2 service returned an invalid startup response');
  }
  const url = new URL(String(parsed.url));
  if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')) {
    throw new Error('OpenCode V2 service returned a non-loopback URL');
  }
  return { url: url.toString().replace(/\/$/, '') };
}

async function waitForHealth(client: OpenCodeClient, signal: AbortSignal): Promise<void> {
  let lastError: unknown;
  while (!signal.aborted) {
    try {
      await client.health.get({ signal });
      return;
    } catch (error) {
      if (error !== signal.reason) lastError = error;
      if (!signal.aborted) await Bun.sleep(50);
    }
  }
  if (lastError !== undefined) {
    throw new Error('OpenCode V2 runtime health check did not succeed', { cause: lastError });
  }
  throw signal.reason ?? new Error('OpenCode V2 runtime startup stopped');
}

async function waitForPlugin(
  client: OpenCodeClient,
  pluginId: string,
  signal: AbortSignal
): Promise<void> {
  while (!signal.aborted) {
    const plugins = await client.plugin.list(undefined, { signal });
    const plugin = plugins.data.find(candidate => candidate.id === pluginId);
    if (plugin?.status === 'active') return;
    if (plugin?.status === 'failed') {
      throw new Error(`OpenCode V2 failed to load the Archon native-tools plugin: ${plugin.error}`);
    }
    await Bun.sleep(50);
  }
  throw signal.reason ?? new Error('OpenCode V2 native-tools plugin startup stopped');
}

function mergeConfigContent(existing: string | undefined, pluginContent: string): string {
  const base: unknown = existing ? JSON.parse(existing) : {};
  const plugin: unknown = JSON.parse(pluginContent);
  if (
    typeof base !== 'object' ||
    base === null ||
    Array.isArray(base) ||
    typeof plugin !== 'object' ||
    plugin === null ||
    Array.isArray(plugin)
  ) {
    throw new Error('OPENCODE_CONFIG_CONTENT must contain a JSON object');
  }
  const baseRecord = base as Record<string, unknown>;
  const pluginRecord = plugin as Record<string, unknown>;
  const existingPlugins = baseRecord.plugin ?? [];
  if (!Array.isArray(existingPlugins) || !Array.isArray(pluginRecord.plugin)) {
    throw new Error('OpenCode plugin config must be an array');
  }
  return JSON.stringify({
    ...baseRecord,
    plugin: [...existingPlugins, ...pluginRecord.plugin],
  });
}

/** Start an Archon-owned V2 sidecar and stop exactly that process on release. */
export async function acquireV2Runtime(
  signal?: AbortSignal,
  nativeTools: readonly NativeTool[] = []
): Promise<V2Runtime> {
  if (signal?.aborted) throw abortError();

  const binary = await resolveOpencodeV2Binary();
  await assertMatchingVersion(binary, signal);
  if (signal?.aborted) throw abortError();

  const password = randomBytes(32).toString('base64url');
  const nativeToolsBridge =
    nativeTools.length > 0 ? await startNativeToolsV2Bridge(nativeTools) : undefined;
  if (signal?.aborted) {
    await nativeToolsBridge?.close();
    throw abortError();
  }
  const startupController = new AbortController();
  const abortHandler = (): void => {
    startupController.abort(abortError());
  };
  signal?.addEventListener('abort', abortHandler, { once: true });
  if (signal?.aborted) {
    signal.removeEventListener('abort', abortHandler);
    await nativeToolsBridge?.close();
    throw abortError();
  }
  const timeout = setTimeout(() => {
    startupController.abort(new Error('OpenCode V2 runtime startup timed out'));
  }, 10_000);
  let child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  try {
    child = Bun.spawn([binary, 'serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      signal: startupController.signal,
      env: {
        ...process.env,
        OPENCODE_SERVER_USERNAME: 'opencode',
        OPENCODE_SERVER_PASSWORD: password,
        ...(nativeToolsBridge
          ? {
              OPENCODE_CONFIG_CONTENT: mergeConfigContent(
                process.env.OPENCODE_CONFIG_CONTENT,
                nativeToolsBridge.configContent
              ),
            }
          : {}),
      },
    });
  } catch (error) {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortHandler);
    await nativeToolsBridge?.close();
    throw error;
  }
  const stderr = new Response(child.stderr).text().catch(() => '');

  let endpoint: Endpoint;
  let client: OpenCodeClient;
  try {
    const reportedEndpoint = await readEndpoint(child.stdout);
    endpoint = {
      ...reportedEndpoint,
      auth: { type: 'basic', username: 'opencode', password },
    };
    client = OpenCode.make({
      baseUrl: endpoint.url,
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
      },
    });
    await waitForHealth(client, startupController.signal);
    if (nativeToolsBridge) {
      await waitForPlugin(client, nativeToolsBridge.pluginId, startupController.signal);
    }
  } catch (error) {
    child.stdin.end();
    child.kill();
    await child.exited.catch(() => undefined);
    const detail = (await stderr).trim();
    await nativeToolsBridge?.close();
    if (signal?.aborted) throw abortError();
    throw new Error(`OpenCode V2 runtime failed to start${detail ? `: ${detail}` : ''}`, {
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortHandler);
  }

  let released = false;
  return {
    endpoint,
    client,
    release: async (): Promise<void> => {
      if (released) return;
      released = true;
      child.stdin.end();
      child.kill();
      try {
        await child.exited;
      } finally {
        await nativeToolsBridge?.close();
      }
    },
  };
}
