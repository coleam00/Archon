import { createLogger } from '@archon/paths';
import type { MessageChunk } from '@archon/provider-contract';
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
  | { from: 'texts-end' };

/** Both sources in arrival order, until the notifications end. */
async function* interleaved(
  notifications: AsyncIterator<ServerNotification>,
  turnMessages: AsyncIterable<string> | undefined
): AsyncGenerator<Extract<Arrival, { value: unknown }>> {
  let texts = turnMessages?.[Symbol.asyncIterator]();
  let notification: Promise<Arrival> | undefined;
  let text: Promise<Arrival> | undefined;
  while (true) {
    notification ??= notifications
      .next()
      .then(r =>
        r.done === true ? { from: 'notifications-end' } : { from: 'notification', value: r.value }
      );
    if (texts)
      text ??= texts
        .next()
        .then(r => (r.done === true ? { from: 'texts-end' } : { from: 'text', value: r.value }));
    const next = await Promise.race(text ? [notification, text] : [notification]);
    if (next.from === 'text' || next.from === 'texts-end') text = undefined;
    else notification = undefined;
    if (next.from === 'notifications-end') return;
    if (next.from === 'texts-end') texts = undefined;
    else yield next;
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
      code: 'codex.turn_message_refused',
      message: `Codex did not take the engine's message into the turn: ${message}`,
    };
  }
}
