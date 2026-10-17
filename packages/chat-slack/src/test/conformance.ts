import { resolve } from 'node:path';
import { connectChat } from '@archon/chat-contract';
import {
  runChatConformance,
  PluginRemoteError,
  type ChatConformanceFixture,
} from '@archon/chat-contract/conformance';
import { descriptor } from '../descriptor';

export async function processFixture(command?: string[]): Promise<ChatConformanceFixture> {
  const child = Bun.spawn(
    command ?? [
      process.execPath,
      '--preload',
      resolve(import.meta.dir, 'preload.ts'),
      resolve(import.meta.dir, '../main.ts'),
    ],
    {
      cwd: resolve(import.meta.dir, '..'),
      env: { ...process.env, SLACK_BOT_TOKEN: 'fixture-bot', SLACK_APP_TOKEN: 'fixture-app' },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  // A setup failure returns no fixture, so nothing else would stop the child.
  async function connect() {
    const reader = child.stderr.getReader();
    let logs = '';
    let url: string | undefined;
    while (!url) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`fixture exited before readiness: ${logs}`);
      logs += new TextDecoder().decode(chunk.value);
      const index = logs.indexOf('\n');
      if (index < 0) continue;
      const line: unknown = JSON.parse(logs.slice(0, index));
      if (
        typeof line === 'object' &&
        line !== null &&
        'fixtureUrl' in line &&
        typeof line.fixtureUrl === 'string'
      )
        url = line.fixtureUrl;
      else throw new Error('invalid fixture readiness');
    }
    const drainLogs = (async () => {
      while (!(await reader.read()).done) {
        /* Drain withheld plugin diagnostics. */
      }
    })();
    const chat = await connectChat(
      {
        readable: child.stdout,
        writable: new WritableStream({
          async write(value) {
            child.stdin.write(value);
            await child.stdin.flush();
          },
          async close() {
            await child.stdin.end();
          },
        }),
      },
      descriptor
    );
    return { url, chat, drainLogs };
  }
  let connected: Awaited<ReturnType<typeof connect>>;
  try {
    connected = await connect();
  } catch (error) {
    child.kill();
    throw error;
  }
  const { url, chat, drainLogs } = connected;
  async function drive(path: string, value: unknown = {}): Promise<unknown> {
    const response = await fetch(new URL(path, url), {
      method: 'POST',
      body: JSON.stringify(value),
    });
    const raw: unknown = await response.json();
    if (typeof raw === 'object' && raw !== null && 'error' in raw) {
      const error = raw.error;
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'number' &&
        'message' in error &&
        typeof error.message === 'string'
      )
        throw new PluginRemoteError(error.code, error.message, undefined);
      throw new Error('invalid driver error');
    }
    return raw;
  }
  const { chatInboundResponseSchema, chatRunActionResponseSchema } = await import(
    '@archon/chat-contract'
  );
  let armed: Promise<unknown> = Promise.resolve();
  return {
    chat: {
      ...chat,
      async runEvent(event) {
        await armed;
        await chat.runEvent(event);
      },
    },
    inbound: async message => chatInboundResponseSchema.parse(await drive('/inbound', message)),
    runAction: async action => chatRunActionResponseSchema.parse(await drive('/action', action)),
    malformedInbound: () => drive('/malformed'),
    failNextRunEvent() {
      armed = drive('/fail-render');
      return armed.then(() => drive('/rendered')).then(() => {});
    },
    stopped: (async () => {
      const code = await child.exited;
      await drainLogs;
      if (code !== 0) throw new Error(`fixture exited with ${String(code)}`);
    })(),
  };
}

export async function conformance(command?: string[]): Promise<string[]> {
  return runChatConformance(() => processFixture(command));
}
