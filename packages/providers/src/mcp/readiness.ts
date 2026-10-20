import { setTimeout } from 'node:timers/promises';
import type { MessageChunk } from '../types';
import { ClassifiedProviderError } from '../shared/failure';

export type McpStatus = Extract<MessageChunk, { type: 'mcp_server_status' }>;

/**
 * Wait until every declared MCP server is connected, yielding each status change.
 * `readStatuses` observes the session that will receive input; a separate probe could
 * pass while that session's own connection failed.
 */
export async function* requireMcpConnections(
  names: readonly string[],
  readStatuses: () => Promise<readonly McpStatus[]>,
  signal?: AbortSignal
): AsyncGenerator<McpStatus> {
  const observed = new Map<string, McpStatus>();
  while (names.length > 0) {
    signal?.throwIfAborted();
    const statuses = await readMcpStatuses(readStatuses, signal);
    signal?.throwIfAborted();
    let ready = true;
    for (const name of names) {
      const status = requireServerStatus(name, statuses);
      const previous = observed.get(name);
      if (previous?.status !== status.status || previous?.error !== status.error) {
        observed.set(name, status);
        yield status;
        signal?.throwIfAborted();
      }
      assertMcpUsable(status);
      ready = ready && status.status === 'connected';
    }
    if (ready) return;
    await setTimeout(100, undefined, { signal });
  }
}

async function readMcpStatuses(
  read: () => Promise<readonly McpStatus[]>,
  signal?: AbortSignal
): Promise<readonly McpStatus[]> {
  signal?.throwIfAborted();
  if (!signal) return read();
  const cancelled = Promise.withResolvers<never>();
  const onAbort = (): void => cancelled.reject(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([read(), cancelled.promise]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function requireServerStatus(name: string, statuses: readonly McpStatus[]): McpStatus {
  const status = statuses.find(item => item.server === name);
  if (!status) {
    throw new ClassifiedProviderError(
      'misconfigured',
      `Required MCP server "${name}" is missing from the initialized session`
    );
  }
  return status;
}

function assertMcpUsable(status: McpStatus): void {
  if (status.status !== 'connected' && status.status !== 'pending') {
    throw new ClassifiedProviderError(
      'misconfigured',
      `Required MCP server "${status.server}" could not connect (${status.status})${status.error ? `: ${status.error}` : ''}`
    );
  }
}
