import { PluginRemoteError } from '@archon/provider-contract/plugin';
import { chatPluginDescriptorSchema } from './descriptor';
import type { ConnectedChat } from './connect';
import { ChatStartError } from './serve';
import { chatInboundResponseSchema, type ChatInbound, type ChatInboundResponse } from './wire';
import {
  chatRunActionResponseSchema,
  type ChatRunAction,
  type ChatRunActionResponse,
} from './run-actions';

/** Plugin-owned drivers exercise platform traffic without adding fixture methods to the wire. */
export interface ChatConformanceFixture {
  chat: ConnectedChat;
  inbound(message: ChatInbound): Promise<ChatInboundResponse>;
  runAction(action: ChatRunAction): Promise<ChatRunActionResponse>;
  malformedInbound(): Promise<unknown>;
  /** Arrange a rendering failure, then resolve once the event handler has been exercised. */
  failNextRunEvent(): Promise<void>;
  /** Resolves when the plugin has stopped, including its platform connection. */
  stopped: Promise<void>;
}

async function within<T>(task: Promise<T>, graceMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('conformance grace period exceeded'));
        }, graceMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runChatConformance(
  connect: () => Promise<ChatConformanceFixture>,
  graceMs = 5000
): Promise<string[]> {
  const violations: string[] = [];
  let fixture: ChatConformanceFixture;
  try {
    fixture = await within(connect(), graceMs);
  } catch (error) {
    return [`connect: ${error instanceof Error ? error.message : String(error)}`];
  }
  const { chat } = fixture;
  async function check(name: string, run: () => Promise<void>): Promise<void> {
    try {
      await within(run(), graceMs);
    } catch (error) {
      violations.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const rejected = { status: 'rejected', reason: 'not_allowed' } as const;
  let inboundCalls = 0;
  let actionCalls = 0;
  chat.onInbound(message => {
    inboundCalls++;
    return message.sender.platformUserId === 'allowed' ? { status: 'accepted' } : rejected;
  });
  chat.onRunAction(action => {
    actionCalls++;
    return action.sender.platformUserId === 'allowed'
      ? { status: 'done', result: { kind: 'cooperative', cancelled: true } }
      : rejected;
  });
  function assert(condition: boolean, message: string): void {
    if (!condition) throw new Error(message);
  }
  try {
    await check('descriptor', async () => {
      chatPluginDescriptorSchema.parse(chat.descriptor);
    });
    let started = false;
    await check('start', async () => {
      try {
        await chat.start();
        started = true;
      } catch (error) {
        if (!(error instanceof ChatStartError)) throw error;
      }
    });
    if (started) {
      await check('long send', () =>
        chat.send({ conversationId: 'fixture', text: '🦊'.repeat(20000) })
      );
      for (const sender of ['allowed', 'denied']) {
        await check(`inbound ${sender}`, async () => {
          const before = inboundCalls;
          const result = chatInboundResponseSchema.parse(
            await fixture.inbound({
              conversationId: 'fixture',
              text: 'fixture',
              sender: { platformUserId: sender },
            })
          );
          assert(inboundCalls === before + 1, 'inbound did not reach the host exactly once');
          assert(
            result.status === (sender === 'allowed' ? 'accepted' : 'rejected'),
            'unexpected inbound result'
          );
          if (result.status === 'rejected')
            assert(result.reason === 'not_allowed', 'unexpected rejection');
        });
        await check(`run action ${sender}`, async () => {
          const before = actionCalls;
          const result = chatRunActionResponseSchema.parse(
            await fixture.runAction({
              runId: 'fixture',
              action: 'cancel',
              sender: { platformUserId: sender },
            })
          );
          assert(actionCalls === before + 1, 'run action did not reach the host exactly once');
          assert(
            result.status === (sender === 'allowed' ? 'done' : 'rejected'),
            'unexpected run-action result'
          );
          if (result.status === 'rejected')
            assert(result.reason === 'not_allowed', 'unexpected rejection');
        });
      }
      await check('malformed inbound', async () => {
        const before = inboundCalls;
        let failure: unknown;
        try {
          await fixture.malformedInbound();
        } catch (error) {
          failure = error;
        }
        assert(
          failure instanceof PluginRemoteError && failure.code === -32602,
          'malformed inbound did not receive invalid-params'
        );
        assert(inboundCalls === before, 'malformed inbound reached the handler');
      });
      if (chat.descriptor.capabilities.runEvents) {
        await check('rendering failure containment', async () => {
          const rendered = fixture.failNextRunEvent();
          await chat.runEvent({ type: 'terminal', runId: 'fixture', status: 'completed' });
          await rendered;
          await chat.send({ conversationId: 'fixture', text: 'still connected' });
        });
      }
      if (chat.descriptor.capabilities.resultFooter) {
        await check('result footer', () =>
          chat.resultFooter({ conversationId: 'fixture', cost: 0.01 })
        );
      }
    }
  } finally {
    await check('stdin closure', async () => {
      await chat.close();
      await fixture.stopped;
    });
  }
  return violations;
}
