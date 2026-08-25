import { createLogger } from '@archon/paths';
import type { ProviderQueryRequest, ProviderQueryRunner } from '@archon/workflows/deps';
import { loadConfig } from '../config/config-loader';
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

    const options = {
      ...request.options,
      providerAttemptGate: {
        acquire: (): ReturnType<ProviderConcurrencyGate['acquire']> =>
          deps.acquire(request.provider, limit, {
            signal: request.options?.abortSignal,
            observer: request.context,
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
