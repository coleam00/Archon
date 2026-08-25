import { createLogger } from '@archon/paths';
import type { ProviderQueryRequest, ProviderQueryRunner } from '@archon/workflows/deps';
import { loadConfig } from '../config/config-loader';
import { getDatabase } from '../db/connection';
import { ProviderConcurrencyGate, type ProviderConcurrencyLease } from '../db/provider-concurrency';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.query-runner');
  return cachedLog;
}

export interface ProviderQueryRunnerDeps {
  acquire: ProviderConcurrencyGate['acquire'];
  loadLimits: () => Promise<Record<string, number>>;
}

function combineAbortSignals(signals: readonly (AbortSignal | undefined)[]): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  const listeners = new Map<AbortSignal, () => void>();
  for (const signal of active) {
    const abort = (): void => {
      controller.abort(signal.reason);
    };
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener('abort', abort, { once: true });
    listeners.set(signal, abort);
  }
  return {
    signal: controller.signal,
    cleanup: (): void => {
      for (const [signal, listener] of listeners) {
        signal.removeEventListener('abort', listener);
      }
    },
  };
}

export function createProviderQueryRunner(deps: ProviderQueryRunnerDeps): ProviderQueryRunner {
  return async function* runProviderQuery(request: ProviderQueryRequest) {
    const limits = await deps.loadLimits();
    const limit = limits[request.provider];
    if (limit === undefined) {
      yield* request.client.sendQuery(
        request.prompt,
        request.cwd,
        request.resumeSessionId,
        request.options
      );
      return;
    }

    let lease: ProviderConcurrencyLease | undefined;
    let cleanupSignals: (() => void) | undefined;
    try {
      lease = await deps.acquire(request.provider, limit, {
        signal: request.options?.abortSignal,
        observer: request.context,
        shouldContinue: request.context?.shouldContinue,
      });
      const combined = combineAbortSignals([request.options?.abortSignal, lease.signal]);
      cleanupSignals = combined.cleanup;
      const options = { ...request.options, abortSignal: combined.signal };
      yield* request.client.sendQuery(
        request.prompt,
        request.cwd,
        request.resumeSessionId,
        options
      );
    } finally {
      cleanupSignals?.();
      await lease?.release();
    }
  };
}

let sharedGate: ProviderConcurrencyGate | undefined;
function getSharedGate(): ProviderConcurrencyGate {
  sharedGate ??= new ProviderConcurrencyGate(getDatabase());
  return sharedGate;
}

export const runProviderQuery: ProviderQueryRunner = createProviderQueryRunner({
  acquire: (provider, limit, options) => getSharedGate().acquire(provider, limit, options),
  loadLimits: async () => {
    try {
      return (await loadConfig()).concurrency?.providers ?? {};
    } catch (error) {
      // A configured cap must fail closed if its policy cannot be loaded. loadConfig
      // already tolerates ordinary missing/invalid files, so this is an unexpected fault.
      getLog().error({ err: error as Error }, 'provider_concurrency.config_load_failed');
      throw error;
    }
  },
});
