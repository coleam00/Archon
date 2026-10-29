import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const [role, mode, directory, index] = process.argv.slice(2);
if (role === 'native') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  child.unref();
  appendFileSync(join(directory, 'pids'), `${process.pid}\n${child.pid}\n`);
  const send = (frame: object): void => {
    process.stdout.write(`${JSON.stringify(frame)}\n`);
  };
  createInterface({ input: process.stdin }).on('line', line => {
    if (mode === 'credential') return;
    const { id, method } = JSON.parse(line) as { id?: number; method?: string };
    if (id === undefined) return;
    const responses: Record<string, object> = {
      initialize: { codexHome: directory },
      'config/read': { config: { mcp_servers: {} } },
      'plugin/installed': { marketplaces: [] },
      'mcpServerStatus/list': { data: [], nextCursor: null },
      'thread/start': { thread: { id: 'thread' } },
      'thread/resume': { thread: { id: 'thread' } },
      'turn/start': { turn: { id: 'turn' } },
    };
    const result = responses[method ?? ''] ?? {};
    send({ id, result });
    if (method !== 'turn/start') return;
    send({
      method: 'item/completed',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        item: { type: 'agentMessage', id: 'message', text: `ready-${index}` },
      },
    });
    if (mode === 'complete' || (mode === 'split' && index === '1')) {
      send({
        method: 'turn/completed',
        params: {
          threadId: 'thread',
          turn: { id: 'turn', status: 'completed', error: null },
        },
      });
    }
  });
  process.stdin.on('end', () => {
    if (mode !== 'credential') process.exit(0);
  });
  process.on('SIGTERM', () => undefined);
  setInterval(() => undefined, 1000);
} else {
  const { setLogDestination } = await import('@archon/paths');
  setLogDestination('stderr');
  const { serveProvider } = await import('@archon/provider-contract/plugin');
  const { createProvider, descriptor } = await import('@archon/providers/codex/plugin');
  writeFileSync(join(directory, 'plugin'), String(process.pid));
  let count = 0;
  await serveProvider({
    descriptor,
    create: () =>
      createProvider(
        (_command, _args, options) =>
          spawn(
            process.execPath,
            [import.meta.filename, 'native', mode, directory, String(++count)],
            options
          ),
        1
      ),
  });
}
