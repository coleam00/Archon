import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import type { Socket, SocketListener } from 'bun';

export type GroupRunner = (
  args: string[],
  env?: NodeJS.ProcessEnv
) => Promise<{ code: number; pid: number }>;

interface Connection {
  pending: Buffer;
  pid?: number;
  parent?: number;
  filtered: number;
  matched: number;
  closed: Promise<void>;
  close: () => void;
}

function send(socket: Socket<Connection>, id: number, method: string, params = {}) {
  const body = Buffer.from(JSON.stringify({ id, method, params }));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  socket.write(Buffer.concat([header, body]));
}

// JUnit collapses filtered tests and explicit skips. The native inspector reports
// `skipped_because_label` separately, including in Bun's parallel worker processes.
export async function runNameFilteredGroup(
  args: string[],
  run: GroupRunner,
  env: NodeJS.ProcessEnv
): Promise<{ code: number; filtered: number; matched: number }> {
  const connections: Connection[] = [];
  let protocolError: string | undefined;
  const root = mkdtempSync(join(tmpdir(), 'archon-inspect-'));
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\archon-test-${crypto.randomUUID()}`
      : join(root, 'i');
  const readyPrefix = join(root, 'ready-');
  // Test subprocesses inherit inspector settings too; only our preload marks group members.
  const ownedPrefix = join(root, 'owned-');
  const preload = join(root, 'ready.ts');
  let server: SocketListener<Connection> | undefined;
  try {
    writeFileSync(
      preload,
      `import { existsSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(ownedPrefix)} + process.pid, '');
const deadline = Date.now() + 30000;
while (!existsSync(${JSON.stringify(readyPrefix)} + process.pid)) {
  if (Date.now() > deadline) throw new Error('Native test observer did not connect');
  await Bun.sleep(1);
}
`
    );
    server = Bun.listen<Connection>({
      unix: socketPath,
      socket: {
        open(socket) {
          const completion = Promise.withResolvers<void>();
          socket.data = {
            pending: Buffer.alloc(0),
            filtered: 0,
            matched: 0,
            closed: completion.promise,
            close: completion.resolve,
          };
          connections.push(socket.data);
          send(socket, 1, 'TestReporter.enable');
          send(socket, 2, 'Runtime.evaluate', {
            expression: 'JSON.stringify({pid:process.pid,parent:process.ppid})',
            returnByValue: true,
          });
          send(socket, 3, 'Inspector.enable');
        },
        data(socket, bytes) {
          const state = socket.data;
          state.pending = Buffer.concat([state.pending, bytes]);
          while (state.pending.length >= 4) {
            const length = state.pending.readUInt32BE();
            if (state.pending.length < length + 4) break;
            try {
              const message: unknown = JSON.parse(state.pending.subarray(4, length + 4).toString());
              if (typeof message !== 'object' || message === null)
                throw new Error('Invalid inspector message');
              if ('error' in message) throw new Error(JSON.stringify(message.error));
              if ('id' in message && message.id === 2 && 'result' in message) {
                const result = message.result;
                if (typeof result !== 'object' || result === null || !('result' in result))
                  throw new Error('Missing inspector identity');
                const value = result.result;
                if (
                  typeof value !== 'object' ||
                  value === null ||
                  !('value' in value) ||
                  typeof value.value !== 'string'
                )
                  throw new Error('Invalid inspector identity');
                const identity: unknown = JSON.parse(value.value);
                if (
                  typeof identity !== 'object' ||
                  identity === null ||
                  !('pid' in identity) ||
                  typeof identity.pid !== 'number' ||
                  !('parent' in identity) ||
                  typeof identity.parent !== 'number'
                )
                  throw new Error('Invalid inspector process');
                state.pid = identity.pid;
                state.parent = identity.parent;
                writeFileSync(readyPrefix + identity.pid, '');
                send(socket, 4, 'Inspector.initialized');
              }
              if (
                'method' in message &&
                message.method === 'TestReporter.end' &&
                'params' in message
              ) {
                const params = message.params;
                if (typeof params !== 'object' || params === null || !('status' in params))
                  throw new Error('Missing native test status');
                switch (params.status) {
                  case 'skipped_because_label':
                    state.filtered++;
                    break;
                  case 'pass':
                  case 'fail':
                  case 'timeout':
                  case 'skip':
                  case 'todo':
                    state.matched++;
                    break;
                  default:
                    throw new Error(`Unsupported native test status: ${String(params.status)}`);
                }
              }
            } catch (error) {
              protocolError = String(error);
              socket.end();
            }
            state.pending = state.pending.subarray(length + 4);
          }
        },
        close(socket) {
          socket.data.close();
        },
        error(socket, error) {
          protocolError = String(error);
          socket.data.close();
        },
      },
    });
    const insertion = args.indexOf('--');
    const index = insertion < 0 ? args.length : insertion;
    const { code, pid } = await run(
      ['--preload', preload, ...args.slice(0, index), '--pass-with-no-tests', ...args.slice(index)],
      { ...env, BUN_INSPECT: `unix:${socketPath}` }
    );
    const owned = connections.filter(
      state => state.pid === pid || (state.parent === pid && existsSync(ownedPrefix + state.pid))
    );
    await Promise.all(owned.map(state => state.closed));
    if (protocolError !== undefined)
      throw new Error(`Native test results unavailable: ${protocolError}`);
    return {
      code,
      filtered: owned.reduce((sum, state) => sum + state.filtered, 0),
      matched: owned.reduce((sum, state) => sum + state.matched, 0),
    };
  } finally {
    server?.stop(true);
    await removeTempTree(root);
  }
}
