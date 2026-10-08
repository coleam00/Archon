import { afterEach, expect, test, mock } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempTree, testTimeout } from '@archon/paths/test-utils';
import { terminateTree } from '@archon/paths/plugin-process';
import { descriptor } from './fixtures/descriptor';
import type { ConnectedChat } from '@archon/chat-contract';
import { ChatPluginUnavailableError } from './platform';

const records: string[] = [];
const log = (data: unknown, event: string) => {
  records.push(JSON.stringify({ data, event }));
};
mock.module('@archon/paths', () => ({
  createLogger: () => ({ info: log, warn: log, error: log, debug: log }),
}));
const { ChatSupervisor } = await import('./supervisor');
const running: InstanceType<typeof ChatSupervisor>[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map(supervisor => supervisor.stop()));
  await Promise.all(roots.splice(0).map(removeTempTree));
  records.length = 0;
});
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + testTimeout(10_000);
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Condition did not become true');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function fixture(mode: string, args: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'chat-process-'));
  roots.push(root);
  const file = join(root, 'pids');
  let live = false;
  const supervisor = new ChatSupervisor(
    {
      descriptor,
      argv: [process.execPath, join(import.meta.dir, 'fixtures/plugin.ts'), mode, file, ...args],
    },
    () => {},
    value => {
      live = value;
    },
    {
      graceMs: 50,
      backoffMs: 20,
      maxBackoffMs: 80,
      requestTimeoutMs: 500,
    }
  );
  running.push(supervisor);
  supervisor.start();
  const pids = async () =>
    (await readFile(file, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  return { supervisor, live: () => live, pids, file };
}

test.each(['crash', 'retry'])(
  '%s restarts with capped exponential backoff',
  async mode => {
    records.length = 0;
    const { supervisor, pids } = await fixture(mode);
    await until(async () => (await pids()).length >= 4);
    await supervisor.stop();
    const delays = records
      .filter(record => record.includes('restart_scheduled'))
      .map(record => JSON.parse(record).data.delayMs);
    expect(delays.slice(0, 3)).toEqual([20, 40, 80]);
    expect(records.join('\n')).not.toContain('SECRET_TOKEN');
    expect(records.join('\n')).not.toContain('USER_MESSAGE');
  },
  testTimeout(25_000)
);

test(
  'non-retryable starts and changed descriptors remain failed',
  async () => {
    for (const mode of ['nonretry', 'mismatch']) {
      const { supervisor, pids } = await fixture(mode);
      await until(() => records.some(record => record.includes('chat.plugin.closed')));
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(await pids()).toHaveLength(1);
      await expect(
        supervisor.request(connection =>
          connection.send({ conversationId: 'thread', text: 'hello' })
        )
      ).rejects.toBeInstanceOf(ChatPluginUnavailableError);
      await supervisor.stop();
      records.length = 0;
    }
  },
  testTimeout(5_000)
);

test(
  'repeated send timeouts restart a hung plugin',
  async () => {
    const { supervisor, live, pids } = await fixture('hang');
    await until(live);
    for (let i = 0; i < 2; i++) {
      await expect(
        supervisor.request(connection =>
          connection.send({ conversationId: 'thread', text: 'private' })
        )
      ).rejects.toBeInstanceOf(ChatPluginUnavailableError);
      if (i === 0)
        await supervisor.runEvent({ type: 'terminal', runId: 'run', status: 'completed' });
    }
    await until(async () => (await pids()).length >= 2);
  },
  testTimeout(5_000)
);

test(
  'shutdown terminates the recorded process and its descendant',
  async () => {
    const { supervisor, live, pids } = await fixture('descendant');
    await until(live);
    await until(async () => (await pids()).length === 2);
    const ids = (await pids()).map(value => Number(value.replace('child:', '')));
    await supervisor.stop();
    expect(live()).toBe(false);
    await until(() =>
      ids.every(pid => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'ESRCH';
        }
      })
    );
  },
  testTimeout(15_000)
);

test('handlers are installed before chat/start can send traffic', async () => {
  const pair = { inbound: false, action: false };
  const supervisor = new ChatSupervisor(
    {
      descriptor,
      argv: [process.execPath, join(import.meta.dir, 'fixtures/plugin.ts'), 'traffic'],
    },
    (connection: ConnectedChat) => {
      connection.onInbound(() => {
        pair.inbound = true;
        return { status: 'accepted' };
      });
      connection.onRunAction(() => {
        pair.action = true;
        return { status: 'refused', message: 'test' };
      });
    },
    () => {},
    { graceMs: 50 }
  );
  running.push(supervisor);
  supervisor.start();
  await until(() => records.some(record => record.includes('chat.plugin.started')));
  await supervisor.request(connection =>
    connection.send({ conversationId: 'thread', text: 'hello' })
  );
  expect(pair).toEqual({ inbound: true, action: true });
});

test('remote send errors expose only the typed RPC code, never plugin prose', async () => {
  const { supervisor, live } = await fixture('senderror');
  await until(live);
  await expect(
    supervisor.request(connection => connection.send({ conversationId: 'thread', text: 'private' }))
  ).rejects.toBeInstanceOf(ChatPluginUnavailableError);
  expect(records.some(record => record.includes('rpcCode'))).toBe(true);
  expect(records.join('\n')).not.toContain('SECRET_TOKEN');
  expect(records.join('\n')).not.toContain('USER_MESSAGE');
});

test.skipIf(process.platform !== 'win32')(
  'Windows owns descendants after plugin stdin exit and crash',
  async () => {
    for (const mode of ['orphan-eof', 'orphan-crash']) {
      const { supervisor, pids } = await fixture(mode);
      await until(async () => (await pids()).length >= 2);
      const ids = (await pids()).slice(0, 2).map(value => Number(value.replace('child:', '')));
      try {
        if (mode === 'orphan-crash') {
          await until(() => records.some(record => record.includes('restart_scheduled')));
        }
        await supervisor.stop();
        await until(() =>
          ids.every(pid => {
            try {
              process.kill(pid, 0);
              return false;
            } catch (error) {
              return (error as NodeJS.ErrnoException).code === 'ESRCH';
            }
          })
        );
      } finally {
        await Promise.all(ids.map(terminateTree));
      }
      records.length = 0;
    }
  },
  testTimeout(15_000)
);

test.skipIf(process.platform !== 'win32')(
  'Windows launcher preserves executable arguments literally',
  async () => {
    const args = [
      '',
      'space and Unicode æ',
      'embedded " quote',
      'trailing\\',
      "'; $env:USERPROFILE; $(exit 7)",
    ];
    const { supervisor, live, file } = await fixture('arguments', args);
    await until(live);
    expect(JSON.parse(await readFile(`${file}.args`, 'utf8'))).toEqual(args);
    await supervisor.stop();
  },
  testTimeout(5000)
);

test(
  'send deadlines do not bound subprocess initialization',
  async () => {
    const { supervisor, live, pids } = await fixture('slow-bootstrap');
    await until(live);
    expect(await pids()).toHaveLength(1);
    await supervisor.request(connection =>
      connection.send({ conversationId: 'thread', text: 'hello' })
    );
  },
  testTimeout(15_000)
);
