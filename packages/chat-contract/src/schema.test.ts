import { expect, test } from 'bun:test';
import { z } from 'zod';
import document from '../schema/chat-contract.schema.json';
import { chatWireSchemas } from './wire';

function published(name: string): z.ZodType {
  return z.fromJSONSchema({
    ...document,
    $ref: `#/$defs/${name}`,
  } as unknown as z.core.JSONSchema.BaseSchema);
}
test.each(Object.keys(document.$defs))('published %s resolves its references', name => {
  expect(() => published(name)).not.toThrow();
});
test('generated schema and runtime agree on actor and action constraints', () => {
  const fixtures: Partial<Record<keyof typeof chatWireSchemas, unknown[]>> = {
    ChatActor: [
      { kind: 'operator' },
      { kind: 'unidentified' },
      { kind: 'user', userId: 'u' },
      { kind: 'user' },
    ],
    ChatStartFailure: [{ retryable: true }, { retryable: 'yes' }, {}],
    ChatRunAction: [
      { runId: 'r', sender: { platformUserId: 'u' }, action: 'cancel' },
      { runId: 'r', sender: { platformUserId: 'u' }, action: 'respond' },
      {
        runId: 'r',
        sender: { platformUserId: 'u' },
        action: 'respond',
        response: { decision: 'ship', pauseId: 'p', nodeId: 'n' },
      },
    ],
    ChatInbound: [
      { conversationId: 'c', sender: { platformUserId: 'u' }, text: 'hello' },
      { conversationId: 'c', sender: {}, text: 'hello' },
    ],
    ChatRunEvent: [
      { type: 'provider_event', runId: 'r' },
      { type: 'terminal', runId: 'r', status: 'completed', authoredOutcome: 'succeeded' },
    ],
  };
  for (const name of Object.keys(chatWireSchemas) as (keyof typeof chatWireSchemas)[]) {
    for (const value of fixtures[name] ?? []) {
      expect(published(name).safeParse(value).success).toBe(
        chatWireSchemas[name].safeParse(value).success
      );
    }
  }
});
