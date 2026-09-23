/**
 * The server as a resource-start host.
 *
 * The server drains only the host ID the operator names in `ARCHON_TRIGGER_HOST`; it
 * never infers one, because bindings choose their execution host and a guessed ID
 * could run another machine's work. Drains run after a webhook receipt commits and on
 * every continuation-scheduler tick, so queued work advances once its blocker ends
 * without an external cron. Admitted runs start in-process through the engine port.
 */
import {
  drainResourceStartHost,
  startAdmittedResourceStart,
} from '@archon/core/workflows/resource-start-host';
import { createWorkflowDeps } from '@archon/core/workflows/store-adapter';
import { createLogger } from '@archon/paths';
import type { IWorkflowEngine } from '@archon/workflows/engine-port';
import { InProcessWorkflowEngine } from '@archon/workflows/in-process-engine';
import { HeadlessPlatform } from '../adapters/headless';

const log = createLogger('resource-start-hosting');

export interface ServerResourceStartHost {
  /**
   * Run a host pass, or schedule one more if a pass is in flight. Resolves when the
   * pass that covers this request ends; admitted runs keep executing afterwards.
   */
  requestDrain(): Promise<void>;
}

export function createServerResourceStartHost(
  hostId: string,
  engine: IWorkflowEngine = new InProcessWorkflowEngine(createWorkflowDeps())
): ServerResourceStartHost {
  const startAdmitted = async (requestId: string): Promise<void> => {
    // Not awaited: a run can take hours and must not hold the drain or a webhook ACK.
    void startAdmittedResourceStart({
      requestId,
      hostId,
      engine,
      createPlatform: ({ conversationDbId }) => new HeadlessPlatform(conversationDbId),
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
        // A failure before the engine claims the run leaves it pending and holding its
        // slot; nothing retries it. Name the run (a request's ID is its run's ID) and
        // the command that shows the operator's retry and abandon options.
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
      try {
        await drainResourceStartHost({ hostId, startAdmitted });
      } catch (error) {
        log.error({ err: error as Error, hostId }, 'resource_start.drain_failed');
      }
    } while (again);
    running = undefined;
  };

  return {
    requestDrain(): Promise<void> {
      if (running) {
        again = true;
        return running;
      }
      running = pass();
      return running;
    },
  };
}
