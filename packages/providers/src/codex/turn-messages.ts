import { createLogger } from '@archon/paths';
import { TURN_MESSAGE_REFUSED_WARNING_CODE, type MessageChunk } from '@archon/provider-contract';
import type { AppServerConnection } from './app-server';
import type { ServerNotification } from './protocol/ServerNotification';

/** The ids of the parent thread and turn a stream observes. */
export interface TurnIds {
  threadId: string;
  turnId: string;
}

type Warning = Extract<MessageChunk, { type: 'warning' }>;

/**
 * The turn's notifications, with each engine text steered into the active turn as it
 * arrives. Codex reads a steered text at its next sampling step and never interrupts the
 * running command. With no active turn, such as background work still running after the
 * turn completed, Codex refuses it: that is a warning carrying Codex's own error, and no
 * new turn is started. Each source is read only when the consumer asks for more, so
 * nothing is taken off either one once the turn's stream has stopped reading.
 */
export async function* steered(
  connection: AppServerConnection,
  ids: TurnIds,
  turnMessages: AsyncIterable<string> | undefined
): AsyncGenerator<ServerNotification | Warning> {
  for await (const next of interleaved(connection.notifications(), turnMessages)) {
    if (next.from === 'notification') yield next.value;
    else {
      const refused = await steer(connection, ids, next.value);
      if (refused) yield refused;
    }
  }
}

type Arrival =
  | { from: 'notification'; value: ServerNotification }
  | { from: 'text'; value: string }
  | { from: 'notifications-end' }
  | { from: 'texts-end' }
  | { from: 'error'; error: unknown };

/** Arrivals in the order their reads settled, for one consumer. */
function arrivalQueue(): { push(arrival: Arrival): void; take(): Promise<Arrival> } {
  const queued: Arrival[] = [];
  let wake: (() => void) | undefined;
  return {
    push(arrival): void {
      queued.push(arrival);
      wake?.();
      wake = undefined;
    },
    async take(): Promise<Arrival> {
      while (true) {
        const next = queued.shift();
        if (next !== undefined) return next;
        await new Promise<void>(resolve => {
          wake = resolve;
        });
      }
    },
  };
}

/** Start one read whose single reaction queues what it produced. */
function read<T>(
  iterator: AsyncIterator<T>,
  arrivals: ReturnType<typeof arrivalQueue>,
  toArrival: (result: IteratorResult<T>) => Arrival
): void {
  void iterator.next().then(
    result => arrivals.push(toArrival(result)),
    (error: unknown) => arrivals.push({ from: 'error', error })
  );
}

/**
 * Both sources in arrival order, until the notifications end. Each read gets exactly one
 * reaction, attached when it starts, so a session that streams many notifications while
 * no text arrives does not pile reactions onto the one pending text read.
 */
async function* interleaved(
  notifications: AsyncIterator<ServerNotification>,
  turnMessages: AsyncIterable<string> | undefined
): AsyncGenerator<Extract<Arrival, { value: unknown }>> {
  let texts = turnMessages?.[Symbol.asyncIterator]();
  const arrivals = arrivalQueue();
  let readingNotification = false;
  let readingText = false;
  while (true) {
    if (!readingNotification) {
      readingNotification = true;
      read(notifications, arrivals, r =>
        r.done === true ? { from: 'notifications-end' } : { from: 'notification', value: r.value }
      );
    }
    if (texts && !readingText) {
      readingText = true;
      read(texts, arrivals, r =>
        r.done === true ? { from: 'texts-end' } : { from: 'text', value: r.value }
      );
    }
    const next = await arrivals.take();
    switch (next.from) {
      case 'error':
        throw next.error;
      case 'notifications-end':
        return;
      case 'texts-end':
        readingText = false;
        texts = undefined;
        break;
      case 'text':
        readingText = false;
        yield next;
        break;
      case 'notification':
        readingNotification = false;
        yield next;
        break;
    }
  }
}

async function steer(
  connection: AppServerConnection,
  ids: TurnIds,
  text: string
): Promise<Warning | undefined> {
  try {
    await connection.request('turn/steer', {
      threadId: ids.threadId,
      expectedTurnId: ids.turnId,
      input: [{ type: 'text', text, text_elements: [] }],
    });
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    createLogger('provider.codex').warn(
      { err: error, turnId: ids.turnId },
      'codex.turn_message_refused'
    );
    return {
      type: 'warning',
      code: TURN_MESSAGE_REFUSED_WARNING_CODE,
      message: `Codex did not take the engine's message into the turn: ${message}`,
    };
  }
}
