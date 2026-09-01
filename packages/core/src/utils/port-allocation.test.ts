import { describe, it, expect, afterEach } from 'bun:test';
import { createServer, type Server } from 'node:net';
import {
  calculatePortOffset,
  getPort,
  isPortAvailable,
  resolveWorktreePort,
} from './port-allocation';

const BASE_PORT = 3090;
const HOSTNAME = '0.0.0.0';

/** Hold a real listener so availability probes see a genuinely occupied port. */
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

// Test the exported hash calculation function directly
describe('calculatePortOffset', () => {
  it('should calculate consistent hash-based offset for worktree paths', () => {
    const testPath = '/Users/test/.archon/worktrees/owner/repo/issue-123';
    const offset = calculatePortOffset(testPath);

    expect(offset).toBeGreaterThanOrEqual(100);
    expect(offset).toBeLessThanOrEqual(999);

    // Same path should produce same offset (deterministic)
    const offset2 = calculatePortOffset(testPath);
    expect(offset2).toBe(offset);
  });

  it('should produce different offsets for different worktree paths', () => {
    const path1 = '/Users/test/.archon/worktrees/owner/repo/issue-123';
    const path2 = '/Users/test/.archon/worktrees/owner/repo/issue-456';

    const offset1 = calculatePortOffset(path1);
    const offset2 = calculatePortOffset(path2);

    // Different paths SHOULD produce different offsets (likely but not guaranteed)
    // Note: With 900 possible values, collision probability is ~1% for 5 worktrees
    expect(offset1).not.toBe(offset2);
  });

  it('should keep offset in 100-999 range for various paths', () => {
    const testPaths = [
      '/.archon/worktrees/repo/branch',
      '/home/user/.archon/worktrees/owner/repo/issue-1',
      '/very/long/path/to/archon/worktrees/organization/repository/feature-branch-with-long-name',
      '', // Edge case: empty path
      '/a', // Edge case: short path
    ];

    for (const path of testPaths) {
      const offset = calculatePortOffset(path);
      expect(offset).toBeGreaterThanOrEqual(100);
      expect(offset).toBeLessThanOrEqual(999);
    }
  });
});

describe('isPortAvailable', () => {
  const held: Server[] = [];

  afterEach(async () => {
    await Promise.all(held.splice(0).map(release));
  });

  it('reports an unbound port as available', async () => {
    // Port 0 asks the OS for any free port; bind it, learn the number, release it.
    const scout = await occupy(0);
    const address = scout.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await release(scout);

    expect(await isPortAvailable(port, HOSTNAME)).toBe(true);
  });

  it('reports a port held by a live listener as unavailable', async () => {
    const server = await occupy(0);
    held.push(server);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    expect(await isPortAvailable(port, HOSTNAME)).toBe(false);
  });

  it('leaves the probed port bindable afterwards', async () => {
    const scout = await occupy(0);
    const address = scout.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await release(scout);

    expect(await isPortAvailable(port, HOSTNAME)).toBe(true);
    // The probe must not leak its own listener, or the second call would fail.
    expect(await isPortAvailable(port, HOSTNAME)).toBe(true);
  });
});

// Test getPort() behavior with mocked dependencies
describe('getPort', () => {
  const originalEnv = process.env.PORT;
  const held: Server[] = [];

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = originalEnv;
    }
    await Promise.all(held.splice(0).map(release));
  });

  it('should return PORT env var when explicitly set to valid number', async () => {
    process.env.PORT = '4000';
    const port = await getPort();
    expect(port).toBe(4000);
  });

  it('returns an explicit PORT even when that port is already occupied', async () => {
    const server = await occupy(0);
    held.push(server);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    // An explicit PORT is an instruction: probing must not move the operator off it.
    process.env.PORT = String(port);
    expect(await getPort()).toBe(port);
  });

  it('should return a valid port when no PORT env is set', async () => {
    delete process.env.PORT;
    // Note: If running in a worktree, port will be auto-allocated (base 3090 + offset 100-999)
    // If running in main repo, port will be 3090
    const port = await getPort();
    const maxPort = BASE_PORT + 999;
    expect(port).toBeGreaterThanOrEqual(BASE_PORT);
    expect(port).toBeLessThanOrEqual(maxPort);
  });

  it('returns the same port twice when nothing is holding it', async () => {
    delete process.env.PORT;
    // The deterministic-port promise still holds in the common case.
    expect(await getPort()).toBe(await getPort());
  });
});

// Driven directly rather than through getPort(): the worktree branch is only
// reachable when the suite itself runs inside a worktree, which it does not in the
// main repo or in CI. Calling the resolver is what makes the fallback actually run.
describe('resolveWorktreePort', () => {
  const CWD = '/Users/test/.archon/worktrees/owner/repo/issue-123';
  const held: Server[] = [];

  afterEach(async () => {
    await Promise.all(held.splice(0).map(release));
  });

  const hold = async (port: number): Promise<void> => {
    held.push(await occupy(port));
  };

  it('returns the hashed port when it is free', async () => {
    const offset = calculatePortOffset(CWD);
    expect(await resolveWorktreePort(offset, HOSTNAME, CWD)).toBe(BASE_PORT + offset);
  });

  it('advances to the next free port when the hashed one is taken', async () => {
    const offset = calculatePortOffset(CWD);
    await hold(BASE_PORT + offset);

    const port = await resolveWorktreePort(offset, HOSTNAME, CWD);
    expect(port).toBe(BASE_PORT + offset + 1);
  });

  it('skips a contiguous run of occupied ports', async () => {
    const offset = calculatePortOffset(CWD);
    await hold(BASE_PORT + offset);
    await hold(BASE_PORT + offset + 1);
    await hold(BASE_PORT + offset + 2);

    const port = await resolveWorktreePort(offset, HOSTNAME, CWD);
    expect(port).toBe(BASE_PORT + offset + 3);
    expect(await isPortAvailable(port, HOSTNAME)).toBe(true);
  });

  it('returns to the hashed port once it is released again', async () => {
    const offset = calculatePortOffset(CWD);
    const preferred = BASE_PORT + offset;

    await hold(preferred);
    expect(await resolveWorktreePort(offset, HOSTNAME, CWD)).not.toBe(preferred);

    await Promise.all(held.splice(0).map(release));
    expect(await resolveWorktreePort(offset, HOSTNAME, CWD)).toBe(preferred);
  });

  it('wraps from the top of the range back to the bottom', async () => {
    // Offset 999 is the last slot; the next candidate must be 100, not 1000.
    const topOffset = 999;
    await hold(BASE_PORT + topOffset);

    expect(await resolveWorktreePort(topOffset, HOSTNAME, CWD)).toBe(BASE_PORT + 100);
  });

  it('stays inside the 3190-4089 range for every starting offset', async () => {
    for (const offset of [100, 101, 500, 998, 999]) {
      const port = await resolveWorktreePort(offset, HOSTNAME, CWD);
      expect(port).toBeGreaterThanOrEqual(BASE_PORT + 100);
      expect(port).toBeLessThanOrEqual(BASE_PORT + 999);
    }
  });
});

// Integration test notes (manual verification):
// 1. Run in main repo: `bun dev` → should use port 3090 with log "default_port_selected"
// 2. Run in worktree: `bun dev` → should auto-allocate port 3XXX with "worktree_port_allocated"
// 3. Override: `PORT=4000 bun dev` → should use 4000 (both contexts)
// 4. Multiple worktrees: Start in 2+ worktrees → different ports
// 5. Colliding worktrees: occupy a worktree's hashed port, start it → "worktree_port_reallocated"
// 6. Invalid PORT: `PORT=abc bun dev` → should exit with error message
