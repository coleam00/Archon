import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { OpenCode, type OpenCodeClient } from '@opencode-ai/client';
import type { Endpoint } from '@opencode-ai/client/service';

export const OPENCODE_V2_VERSION = '0.0.0-beta-17963';

export interface V2Runtime {
  client: OpenCodeClient;
  endpoint: Endpoint;
  release: () => Promise<void>;
}

async function resolveOpencodeV2Binary(): Promise<string> {
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

/** Start an Archon-owned V2 sidecar and stop exactly that process on release. */
export async function acquireV2Runtime(signal?: AbortSignal): Promise<V2Runtime> {
  if (signal?.aborted) throw abortError();

  const binary = await resolveOpencodeV2Binary();
  await assertMatchingVersion(binary, signal);
  if (signal?.aborted) throw abortError();

  const password = randomBytes(32).toString('base64url');
  const startupController = new AbortController();
  const abortHandler = (): void => {
    startupController.abort(abortError());
  };
  signal?.addEventListener('abort', abortHandler, { once: true });
  if (signal?.aborted) {
    signal.removeEventListener('abort', abortHandler);
    throw abortError();
  }
  const timeout = setTimeout(() => {
    startupController.abort(new Error('OpenCode V2 runtime startup timed out'));
  }, 10_000);
  const child = Bun.spawn([binary, 'serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    signal: startupController.signal,
    env: {
      ...process.env,
      OPENCODE_SERVER_USERNAME: 'opencode',
      OPENCODE_SERVER_PASSWORD: password,
    },
  });
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
  } catch (error) {
    child.stdin.end();
    child.kill();
    await child.exited.catch(() => undefined);
    const detail = (await stderr).trim();
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
      await child.exited;
    },
  };
}
