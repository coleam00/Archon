import { Readable, Writable } from 'node:stream';
import type { BlockButtonAction, ButtonAction } from '@slack/bolt';
import {
  chatInboundSchema,
  chatRunActionSchema,
  type ChatInboundResponse,
  type ChatRunActionResponse,
  type ChatPlugin,
} from '@archon/chat-contract';
import { PluginRemoteError } from '@archon/chat-contract/conformance';
import { serveChat } from '@archon/chat-contract';
import { StubSlack } from './slack';

const actualServeChat = serveChat;
export const slack = new StubSlack();

export async function serveFixture(plugin: ChatPlugin): Promise<void> {
  let started = false;
  let inboundResult: ChatInboundResponse | undefined;
  let actionResult: ChatRunActionResponse | undefined;
  let renderFailure: Promise<void> | undefined;
  let malformedReply: ((raw: unknown) => void) | undefined;
  let buffer = '';
  const decoder = new TextDecoder();
  const readable = Readable.toWeb(process.stdin).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          const raw: unknown = JSON.parse(line);
          if (
            typeof raw === 'object' &&
            raw !== null &&
            'id' in raw &&
            raw.id === 'malformed-fixture'
          )
            malformedReply?.(raw);
          else controller.enqueue(new TextEncoder().encode(line + '\n'));
        }
      },
    })
  );
  const dispatchInbound = async (raw: unknown): Promise<Response> => {
    const message = chatInboundSchema.parse(raw);
    const handler = slack.events.get('app_mention');
    if (!handler) throw new Error('missing Slack mention handler');
    inboundResult = undefined;
    await handler({
      event: {
        channel: message.conversationId,
        ts: '1',
        user: message.sender.platformUserId,
        text: message.text,
      },
    });
    if (!inboundResult) throw new Error('Slack did not dispatch inbound');
    return Response.json(inboundResult);
  };
  const dispatchAction = async (raw: unknown): Promise<Response> => {
    const { sender, ...action } = chatRunActionSchema.parse(raw);
    // Answer and resume controls appear only on attention notices.
    const notice = action.action === 'answer' || action.action === 'resume';
    const actionId =
      action.action === 'cancel'
        ? `cancel:${action.runId}`
        : notice
          ? 'attention:choose:0'
          : 'respond:0';
    const handler = slack.actions.find(entry => entry.pattern.test(actionId));
    if (!handler) throw new Error('missing Slack action handler');
    actionResult = undefined;
    await handler.handler({
      ack: async () => {},
      body: {
        user: { id: sender.platformUserId },
        channel: { id: 'fixture' },
        message: { ts: '1' },
      } as BlockButtonAction,
      action: {
        type: 'button',
        action_id: actionId,
        value:
          action.action === 'cancel'
            ? undefined
            : notice
              ? JSON.stringify(action)
              : JSON.stringify({ runId: action.runId, ...action.response }),
      } as ButtonAction,
    });
    if (!actionResult) throw new Error('Slack did not dispatch run action');
    return Response.json(actionResult);
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      try {
        if (!started) throw new Error('fixture not started');
        const raw: unknown = await request.json();
        if (path === '/inbound') return await dispatchInbound(raw);
        if (path === '/action') return await dispatchAction(raw);
        if (path === '/malformed') {
          const reply = new Promise<unknown>(resolve => {
            malformedReply = resolve;
          });
          // Deliberately bypass serveChat's outbound validation to exercise host validation.
          process.stdout.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'malformed-fixture',
              method: 'chat/inbound',
              params: { sender: {} },
            }) + '\n'
          );
          return Response.json(await reply);
        }
        if (path === '/fail-render') {
          await plugin.onRunEvent?.({
            type: 'workflow_started',
            runId: 'fixture',
            conversationId: 'fixture',
            workflowName: 'fixture',
          });
          renderFailure = new Promise<void>(resolve => {
            slack.rendered = resolve;
          });
          slack.failNextRender = true;
          return Response.json({});
        }
        if (path === '/rendered') {
          await renderFailure;
          return Response.json({});
        }
        throw new Error('unknown fixture driver');
      } catch (error) {
        return Response.json(
          {
            error:
              error instanceof PluginRemoteError
                ? { code: error.code, message: error.message, data: error.data }
                : { code: -32000, message: String(error) },
          },
          { status: 500 }
        );
      }
    },
  });
  console.error(JSON.stringify({ fixtureUrl: server.url.toString() }));
  try {
    await actualServeChat(
      {
        descriptor: plugin.descriptor,
        async start(context) {
          await plugin.start({
            async inbound(message) {
              inboundResult = await context.inbound(message);
              return inboundResult;
            },
            async runAction(action) {
              actionResult = await context.runAction(action);
              return actionResult;
            },
          });
          started = true;
        },
        send: plugin.send.bind(plugin),
        resultFooter: plugin.resultFooter?.bind(plugin),
        onRunEvent: plugin.onRunEvent?.bind(plugin),
        attentionNotice: plugin.attentionNotice?.bind(plugin),
      },
      { readable, writable: Writable.toWeb(process.stdout) }
    );
  } finally {
    process.once('beforeExit', () => {
      if (slack.started && !slack.stopped) process.exitCode = 1;
    });
    await server.stop(true);
  }
}
