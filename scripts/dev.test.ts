import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:net';
import {
  DEV_SERVER_PORT_ENV,
  calculatePortOffset,
  getPort,
  resolveWorktreePort,
} from '@archon/core/utils/port-allocation';
import { resolveApiPort } from '../packages/web/vite.config';
import { createDevEnvironment } from './dev';

const BASE_PORT = 3090;
const HOSTNAME = '0.0.0.0';
const WORKTREE_PATH = '/tmp/archon/.worktrees/endpoint-handoff';

function occupy(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, HOSTNAME, () => resolve(server));
  });
}

function release(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

describe('development endpoint handoff', () => {
  const originalPort = process.env.PORT;
  const originalDevPort = process.env[DEV_SERVER_PORT_ENV];
  let held: Server | undefined;

  afterEach(async () => {
    if (held) await release(held);
    held = undefined;
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
    if (originalDevPort === undefined) delete process.env[DEV_SERVER_PORT_ENV];
    else process.env[DEV_SERVER_PORT_ENV] = originalDevPort;
  });

  test('the server, REST proxy, and SSE receive the collision-selected worktree port', async () => {
    const preferredPort = BASE_PORT + calculatePortOffset(WORKTREE_PATH);
    held = await occupy(preferredPort);
    const selectedPort = await resolveWorktreePort(
      calculatePortOffset(WORKTREE_PATH),
      HOSTNAME,
      WORKTREE_PATH
    );
    expect(selectedPort).not.toBe(preferredPort);

    const devEnv = createDevEnvironment(selectedPort, {});
    delete process.env.PORT;
    process.env[DEV_SERVER_PORT_ENV] = devEnv[DEV_SERVER_PORT_ENV];

    expect(await getPort()).toBe(selectedPort);
    expect(resolveApiPort({}, devEnv)).toBe(String(selectedPort));
    expect(devEnv.VITE_API_PORT).toBe(String(selectedPort));
    expect(resolveApiPort({ PORT: '4000' }, devEnv)).toBe('4000');
  });
});
