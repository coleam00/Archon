import { createLogger } from '@archon/paths';
import type { IAgentProvider, ProviderAttemptLease } from '@archon/providers/types';
import type { ProviderQueryRequest, ProviderQueryRunner } from '@archon/workflows/deps';
import { loadProviderConcurrencyLimits } from '../config/config-loader';
import { getDatabase } from '../db/connection';
import {
  ProviderConcurrencyGate,
  type ProviderConcurrencyAcquired,
  type ProviderConcurrencyWait,
} from '../db/provider-concurrency';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.query-runner');
  return cachedLog;
}

export interface ProviderQueryRunnerDeps {
  acquire: ProviderConcurrencyGate['acquire'];
  loadLimits: () => Promise<Record<string, number>>;
}

function supportsAdmission(client: IAgentProvider): boolean {
  return client.supportsProviderAttemptGate === true;
}

export function createProviderQueryRunner(deps: ProviderQueryRunnerDeps): ProviderQueryRunner {
  return async function* runProviderQuery(request: ProviderQueryRequest) {
    const provider = request.client.getType();
    const limits = await deps.loadLimits();
    const limit = limits[provider];
    if (limit === undefined) {
      yield* request.client.sendQuery(
        request.prompt,
        request.cwd,
        request.resumeSessionId,
        request.options
      );
      return;
    }

    if (!supportsAdmission(request.client)) {
      throw new Error(
        `Provider '${provider}' does not support install-wide concurrency admission. ` +
          `Remove concurrency.providers.${provider} or update the provider implementation.`
      );
    }

    let queuedAttempts = 0;
    let activeAttempts = 0;
    let queryQueued = false;
    let latestQueuedEvent: ProviderConcurrencyWait | undefined;
    const enterQueued = (event: ProviderConcurrencyWait): void => {
      latestQueuedEvent = event;
      if (queryQueued || activeAttempts > 0 || queuedAttempts === 0) return;
      queryQueued = true;
      request.context?.onQueued?.(event);
    };
    const enterActive = (event: ProviderConcurrencyAcquired): void => {
      if (!queryQueued) return;
      queryQueued = false;
      request.context?.onAcquired?.(event);
    };
    const options = {
      ...request.options,
      providerAttemptGate: {
        acquire: async (attemptSignal?: AbortSignal): Promise<ProviderAttemptLease> => {
          let acquiredEvent: ProviderConcurrencyAcquired | undefined;
          const lease = await deps.acquire(provider, limit, {
            signal:
              request.options?.abortSignal && attemptSignal
                ? AbortSignal.any([request.options.abortSignal, attemptSignal])
                : (request.options?.abortSignal ?? attemptSignal),
            observer: request.context
              ? {
                  onQueued: (event): void => {
                    queuedAttempts += 1;
                    enterQueued(event);
                  },
                  onWaiting: (): void => {
                    if (queryQueued && activeAttempts === 0 && queuedAttempts > 0) {
                      request.context?.onWaiting?.();
                    }
                  },
                  onAcquired: (event): void => {
                    queuedAttempts = Math.max(0, queuedAttempts - 1);
                    acquiredEvent = event;
                  },
                  onDequeued: (): void => {
                    queuedAttempts = Math.max(0, queuedAttempts - 1);
                  },
                }
              : undefined,
            shouldContinue: request.context?.shouldContinue,
          });
          activeAttempts += 1;
          enterActive(acquiredEvent ?? { provider, limit, slot: lease.slot, waitMs: 0 });
          let released = false;
          return {
            ...lease,
            release: async (releaseOptions: { upstreamStopped: boolean }): Promise<void> => {
              if (released) return;
              released = true;
              try {
                await lease.release(releaseOptions);
              } finally {
                activeAttempts = Math.max(0, activeAttempts - 1);
                if (latestQueuedEvent) enterQueued(latestQueuedEvent);
              }
            },
          };
        },
      },
    };
    yield* request.client.sendQuery(request.prompt, request.cwd, request.resumeSessionId, options);
  };
}

export const runProviderQuery: ProviderQueryRunner = createProviderQueryRunner({
  acquire: (provider, limit, options) =>
    new ProviderConcurrencyGate(getDatabase()).acquire(provider, limit, options),
  loadLimits: async (): Promise<Record<string, number>> => {
    try {
      return await loadProviderConcurrencyLimits();
    } catch (error) {
      // A configured cap must fail closed if its policy cannot be loaded.
      getLog().error({ err: error as Error }, 'provider_concurrency.config_load_failed');
      throw error;
    }
  },
});
