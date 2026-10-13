import type { ProviderDiagnostics } from '@archon/provider-contract';
import { probeOpencodeRuntime } from './runtime';

export async function diagnoseOpencode(
  signal: AbortSignal,
  probe: typeof probeOpencodeRuntime = probeOpencodeRuntime
): Promise<ProviderDiagnostics> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => {
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error(String(reason)));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  let availability: Awaited<ReturnType<typeof probeOpencodeRuntime>>;
  try {
    // Dynamic SDK imports cannot be stopped; cancellation releases the caller.
    availability = await Promise.race([probe(signal), cancelled]);
    signal.throwIfAborted();
  } catch (error) {
    signal.throwIfAborted();
    return {
      checks: [
        {
          id: 'opencode-runtime',
          label: 'OpenCode runtime',
          status: 'fail',
          message: `runtime SDK not resolvable: ${error instanceof Error ? error.message : String(error)}`,
          remedy: 'Reinstall dependencies (bun install).',
        },
      ],
    };
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }

  switch (availability) {
    case 'ready':
      return {
        checks: [
          {
            id: 'opencode-runtime',
            label: 'OpenCode runtime',
            status: 'ok',
            message: 'embedded runtime SDK and opencode executable present (server not started)',
          },
        ],
      };
    case 'executable-missing':
      return {
        checks: [
          {
            id: 'opencode-runtime',
            label: 'OpenCode runtime',
            status: 'fail',
            message: 'opencode executable not found on PATH.',
            remedy: 'Install the OpenCode CLI and add it to PATH.',
          },
        ],
      };
    case 'sdk-entrypoint-missing':
      return {
        checks: [
          {
            id: 'opencode-runtime',
            label: 'OpenCode runtime',
            status: 'fail',
            message: '@opencode-ai/sdk resolved but the createOpencode entrypoint is missing.',
            remedy: 'Reinstall dependencies (bun install).',
          },
        ],
      };
  }
}
