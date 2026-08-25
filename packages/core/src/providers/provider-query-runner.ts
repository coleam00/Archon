import { createLogger } from '@archon/paths';
import type { IAgentProvider } from '@archon/providers/types';
import type { ProviderQueryRequest, ProviderQueryRunner } from '@archon/workflows/deps';
import { loadProviderConcurrencyLimits } from '../config/config-loader';
import { getDatabase } from '../db/connection';
import { ProviderConcurrencyGate } from '../db/provider-concurrency';

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
    const options = {
      ...request.options,
      providerAttemptGate: {
        acquire: (attemptSignal?: AbortSignal): ReturnType<ProviderConcurrencyGate['acquire']> =>
          deps.acquire(provider, limit, {
            signal:
              request.options?.abortSignal && attemptSignal
                ? AbortSignal.any([request.options.abortSignal, attemptSignal])
                : (request.options?.abortSignal ?? attemptSignal),
            observer: request.context
              ? {
                  onQueued: (event): void => {
                    queuedAttempts += 1;
                    if (queuedAttempts === 1) request.context?.onQueued?.(event);
                  },
                  onWaiting: request.context.onWaiting,
                  onAcquired: (event): void => {
                    queuedAttempts = Math.max(0, queuedAttempts - 1);
                    if (queuedAttempts === 0) request.context?.onAcquired?.(event);
                  },
                  onDequeued: (): void => {
                    queuedAttempts = Math.max(0, queuedAttempts - 1);
                  },
                }
              : undefined,
            shouldContinue: request.context?.shouldContinue,
          }),
      },
    };
    yield* request.client.sendQuery(request.prompt, request.cwd, request.resumeSessionId, options);
  };
}

let sharedGate: ProviderConcurrencyGate | undefined;
function getSharedGate(): ProviderConcurrencyGate {
  sharedGate ??= new ProviderConcurrencyGate(getDatabase());
  return sharedGate;
}

export const runProviderQuery: ProviderQueryRunner = createProviderQueryRunner({
  acquire: (provider, limit, options) => getSharedGate().acquire(provider, limit, options),
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
