import { subscribeResourceStartReleases } from '@archon/core/workflows/resource-start-completion';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { toPersistedMessageMetadata } from '@archon/core/types';
/**
 * The server as a resource-start host.
 *
 * The server drains only the host ID the operator names in `ARCHON_TRIGGER_HOST`; it
 * never infers one, because bindings choose their execution host and a guessed ID
 * could run another machine's work. Committed releases drain after cleanup; webhook
 * receipts and scheduler ticks are intake and recovery backstops. Admitted runs
 * start in-process through the engine port.
 */
import {
  drainResourceStartHost,
  startAdmittedResourceStart,
} from '@archon/core/workflows/resource-start-host';
import { createLogger } from '@archon/paths';
import { HeadlessPlatform } from '@archon/core/workflows/headless-platform';

const log = createLogger('resource-start-hosting');

export interface ServerResourceStartHost {
  workflowHost: WorkflowHost;
  dispose(): void;
  /**
   * Run a host pass, or schedule one more if a pass is in flight. Resolves when the
   * pass that covers this request ends; admitted runs keep executing afterwards.
   */
  requestDrain(): Promise<void>;
}

export function createServerResourceStartHost(
  hostId: string,
  host: WorkflowHost
): ServerResourceStartHost {
  const dispose = subscribeResourceStartReleases(
    host,
    async (recordedHostId, excludedResources) => {
      if (recordedHostId !== hostId) return;
      // A cleanup-constrained release must not merge into an unrestricted scheduler pass.
      if (excludedResources.length) await drain(excludedResources);
      else await requestDrain();
    }
  );
  const startAdmitted = async (requestId: string): Promise<void> => {
    // Not awaited: a run can take hours and must not hold the drain or a webhook ACK.
    void startAdmittedResourceStart({
      requestId,
      hostId,
      host,
      createPlatform: ({ origin }) => {
        const conversationId = origin?.conversationId;
        return new HeadlessPlatform(
          conversationId
            ? async (message, metadata): Promise<void> => {
                await host.records.messages.addMessage(
                  conversationId,
                  'assistant',
                  message,
                  toPersistedMessageMetadata(metadata)
                );
              }
            : undefined
        );
      },
    })
      .then(result => {
        if (!result.success) {
          log.warn(
            { requestId, runId: result.workflowRunId, error: result.error },
            'resource_start.run_unsuccessful'
          );
        }
      })
      .catch((error: unknown) => {
        // Preparation errors are recorded under ownership; an unowned failure or an
        // ambiguous submission may still need operator recovery through inspection.
        log.error(
          {
            err: error as Error,
            requestId,
            runId: requestId,
            recoveryCommand: `archon trigger inspect ${requestId}`,
          },
          'resource_start.start_failed'
        );
      });
  };

  let running: Promise<void> | undefined;
  let again = false;
  const pass = async (): Promise<void> => {
    do {
      again = false;
      await drain();
    } while (again);
    running = undefined;
  };

  async function drain(excludedResources: readonly string[] = []): Promise<void> {
    try {
      await drainResourceStartHost({ ...host, hostId, startAdmitted }, excludedResources);
    } catch (error) {
      log.error({ err: error as Error, hostId }, 'resource_start.drain_failed');
    }
  }

  function requestDrain(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = pass();
    return running;
  }
  return { workflowHost: host, requestDrain, dispose };
}
