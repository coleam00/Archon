import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.cursor.bun-guard');
  return cachedLog;
}

function isCursorHttp2TailError(reason: unknown): boolean {
  const msg = reason instanceof Error ? reason.message : String(reason);
  return msg.includes('NGHTTP2_FRAME_SIZE_ERROR') || msg.includes('ERR_HTTP2_STREAM_ERROR');
}

/**
 * @cursor/sdk + connect-node emit a late HTTP/2 tail rejection under Bun after
 * successful runs. Swallow only that known-safe pattern for the guard lifetime.
 */
export function installBunCursorHttp2Guard(): () => void {
  if (typeof (globalThis as { Bun?: unknown }).Bun === 'undefined') {
    return () => undefined;
  }

  const handler = (reason: unknown): void => {
    if (!isCursorHttp2TailError(reason)) return;
    getLog().debug(
      { err: reason instanceof Error ? reason.message : String(reason) },
      'cursor.http2_tail_rejection_swallowed'
    );
  };

  process.on('unhandledRejection', handler);
  return () => {
    process.off('unhandledRejection', handler);
  };
}

export async function awaitBunCursorHttp2Tail(): Promise<void> {
  if (typeof (globalThis as { Bun?: unknown }).Bun === 'undefined') return;
  await new Promise<void>(resolve => {
    setTimeout(resolve, 100);
  });
}
