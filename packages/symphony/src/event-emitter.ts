/**
 * SymphonyEventEmitter — typed event emitter for Symphony dispatch observability.
 *
 * Mirrors `WorkflowEventEmitter` (@archon/workflows/event-emitter) so the
 * Mission Control SSE endpoint can subscribe to a single, predictable shape.
 * The orchestrator emits events at every dispatch state transition; the
 * existing `onObserve` poller-callback array stays for the snapshot view.
 */
import { EventEmitter } from 'events';
import { createLogger } from '@archon/paths';
import type { TrackerKind } from './config/snapshot';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('symphony.emitter');
  return cachedLog;
}

interface DispatchClaimedEvent {
  type: 'dispatch_claimed';
  tracker: TrackerKind;
  identifier: string;
  dispatchKey: string;
  codebaseId: string | null;
  attempt: number;
}

interface DispatchStartedEvent {
  type: 'dispatch_started';
  tracker: TrackerKind;
  identifier: string;
  dispatchKey: string;
  workflowRunId: string;
  dispatchId: string;
  codebaseId: string | null;
  workflowName: string;
}

interface DispatchCompletedEvent {
  type: 'dispatch_completed';
  tracker: TrackerKind;
  identifier: string;
  dispatchKey: string;
  workflowRunId: string;
  prUrl?: string;
}

interface DispatchFailedEvent {
  type: 'dispatch_failed';
  tracker: TrackerKind;
  identifier: string;
  dispatchKey: string;
  workflowRunId: string | null;
  errorClass: string;
  errorMessage: string;
}

interface DispatchCancelledEvent {
  type: 'dispatch_cancelled';
  tracker: TrackerKind;
  identifier: string;
  dispatchKey: string;
  workflowRunId: string | null;
  reason: string;
}

interface DispatchRetryScheduledEvent {
  type: 'dispatch_retry_scheduled';
  tracker: TrackerKind;
  identifier: string;
  dispatchKey: string;
  attempt: number;
  dueAt: string;
  delayKind: 'continuation' | 'failure';
  lastError: string | null;
}

interface TrackerPollCompletedEvent {
  type: 'tracker_poll_completed';
  tracker: TrackerKind;
  candidateCount: number;
  durationMs: number;
}

export type SymphonyEmitterEvent =
  | DispatchClaimedEvent
  | DispatchStartedEvent
  | DispatchCompletedEvent
  | DispatchFailedEvent
  | DispatchCancelledEvent
  | DispatchRetryScheduledEvent
  | TrackerPollCompletedEvent;

type Listener = (event: SymphonyEmitterEvent) => void;

const SYMPHONY_EVENT = 'symphony_event';

class SymphonyEventEmitter {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  emit(event: SymphonyEmitterEvent): void {
    try {
      this.emitter.emit(SYMPHONY_EVENT, event);
    } catch (error) {
      getLog().error({ err: error as Error, eventType: event.type }, 'event_emit_failed');
    }
  }

  subscribe(listener: Listener): () => void {
    const safeListener = (event: SymphonyEmitterEvent): void => {
      try {
        listener(event);
      } catch (error) {
        getLog().error({ err: error as Error, eventType: event.type }, 'event_listener_error');
      }
    };

    this.emitter.on(SYMPHONY_EVENT, safeListener);
    return (): void => {
      this.emitter.removeListener(SYMPHONY_EVENT, safeListener);
    };
  }
}

let instance: SymphonyEventEmitter | null = null;

export function getSymphonyEventEmitter(): SymphonyEventEmitter {
  if (!instance) {
    instance = new SymphonyEventEmitter();
  }
  return instance;
}

/** Reset singleton for testing. */
export function resetSymphonyEventEmitter(): void {
  instance = null;
}
