/**
 * The provider-attempt admission seam. Every provider Archon calls comes from this
 * `getAgentProvider`; lint forbids importing the registry's unadmitted one elsewhere.
 *
 * With no `concurrency.providers.<id>` cap the provider is returned behavior-for-
 * behavior: no database access and no waiting. With a cap, each `sendQuery` takes one
 * slot before the provider starts and gives it back only after the provider's own
 * stream has closed, so an aborted attempt keeps its slot until the provider has
 * actually stopped. Waiting for a slot is an abortable in-process poll.
 */
import { randomUUID } from 'node:crypto';
import { createLogger } from '@archon/paths';
import { getAgentProvider as getRegisteredAgentProvider } from '@archon/providers';
import type {
  IAgentProvider,
  MessageChunk,
  ProviderAdmissionEvent,
  ProviderAttemptAdmission,
  SendQueryOptions,
} from '@archon/providers';
import { loadProviderConcurrencyCaps } from '../config/provider-concurrency';
import { releaseProviderAttempt, tryAdmitProviderAttempt } from '../db/provider-attempts';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider-admission');
  return cachedLog;
}

const DEFAULT_POLL_MS = 1_000;

export class ProviderAdmissionAbortedError extends Error {
  constructor(readonly provider: string) {
    super(`Query aborted while waiting for '${provider}' provider capacity`);
    this.name = 'ProviderAdmissionAbortedError';
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise(resolve => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * One `sendQuery` call's slot. Released at most once per acquisition; `releaseDuring`
 * acquires again after a provider's retry backoff.
 */
class ProviderSlot implements ProviderAttemptAdmission {
  private attemptId: string | null = null;
  private capacity = 0;

  constructor(
    private readonly provider: string,
    private readonly options: SendQueryOptions | undefined,
    private readonly pollMs: number
  ) {}

  private emit(state: ProviderAdmissionEvent['state'], attemptId: string): void {
    this.options?.onAdmission?.({
      state,
      provider: this.provider,
      attemptId,
      capacity: this.capacity,
    });
  }

  /**
   * Returns false, holding nothing, when the provider has no cap configured. The cap is
   * re-read on every poll, so a waiter admits against the current cap, and a cap
   * removed while it waits lets it proceed uncapped.
   */
  async acquire(): Promise<boolean> {
    const attemptId = randomUUID();
    const signal = this.options?.abortSignal;
    let waiting = false;
    for (;;) {
      if (signal?.aborted) {
        if (waiting)
          getLog().info({ provider: this.provider, attemptId }, 'provider_admission.wait_aborted');
        throw new ProviderAdmissionAbortedError(this.provider);
      }
      const capacity = (await loadProviderConcurrencyCaps()).get(this.provider);
      if (capacity === undefined) return false;
      this.capacity = capacity;
      const { admitted, live } = await tryAdmitProviderAttempt({
        provider: this.provider,
        capacity,
        attemptId,
      });
      if (admitted) {
        this.attemptId = attemptId;
        getLog().debug({ provider: this.provider, attemptId, live }, 'provider_admission.admitted');
        this.emit('admitted', attemptId);
        return true;
      }
      if (!waiting) {
        waiting = true;
        getLog().info(
          { provider: this.provider, attemptId, capacity, live },
          'provider_admission.waiting'
        );
        this.emit('waiting', attemptId);
      }
      await sleep(this.pollMs, signal);
    }
  }

  async release(): Promise<void> {
    const attemptId = this.attemptId;
    if (attemptId === null) return;
    this.attemptId = null;
    await releaseProviderAttempt(this.provider, attemptId);
    getLog().debug({ provider: this.provider, attemptId }, 'provider_admission.released');
    this.emit('released', attemptId);
  }

  async releaseDuring(wait: () => Promise<void>): Promise<void> {
    await this.release();
    await wait();
    await this.acquire();
  }
}

async function* admittedQuery(
  id: string,
  provider: IAgentProvider,
  pollMs: number,
  prompt: string,
  cwd: string,
  resumeSessionId: string | undefined,
  options: SendQueryOptions | undefined
): AsyncGenerator<MessageChunk> {
  const slot = new ProviderSlot(id, options, pollMs);
  if (!(await slot.acquire())) {
    yield* provider.sendQuery(prompt, cwd, resumeSessionId, options);
    return;
  }
  let failed = false;
  try {
    yield* provider.sendQuery(prompt, cwd, resumeSessionId, { ...options, admission: slot });
  } catch (error) {
    failed = true;
    // The attempt's own error is what the caller needs. A release failure here is
    // logged; its holder stays until this process exits, then the next admission on
    // this host releases it.
    await slot.release().catch((releaseError: unknown) => {
      getLog().error(
        { err: releaseError as Error, provider: id },
        'provider_admission.release_failed'
      );
    });
    throw error;
  } finally {
    // Success or consumer return(): a release failure propagates.
    if (!failed) await slot.release();
  }
}

/** A registered provider whose `sendQuery` is admitted against its configured cap. */
export function getAgentProvider(id: string, pollMs = DEFAULT_POLL_MS): IAgentProvider {
  const provider = getRegisteredAgentProvider(id);
  return {
    getType: () => provider.getType(),
    getCapabilities: () => provider.getCapabilities(),
    sendQuery: (prompt, cwd, resumeSessionId, options) =>
      admittedQuery(id, provider, pollMs, prompt, cwd, resumeSessionId, options),
  };
}
