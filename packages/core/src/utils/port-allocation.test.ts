import { describe, it, expect, afterEach, beforeEach, spyOn } from 'bun:test';
import { calculatePortOffset, getPort } from './port-allocation';

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

// Test getPort() behavior with mocked dependencies
describe('getPort', () => {
  const originalPort = process.env.PORT;
  const originalArchonPort = process.env.ARCHON_PORT;

  afterEach(() => {
    if (originalPort === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = originalPort;
    }
    if (originalArchonPort === undefined) {
      delete process.env.ARCHON_PORT;
    } else {
      process.env.ARCHON_PORT = originalArchonPort;
    }
  });

  it('should return ARCHON_PORT when set (takes priority over PORT)', async () => {
    process.env.ARCHON_PORT = '4500';
    process.env.PORT = '4000';
    const port = await getPort();
    expect(port).toBe(4500);
  });

  it('should return PORT env var when ARCHON_PORT is not set', async () => {
    delete process.env.ARCHON_PORT;
    process.env.PORT = '4000';
    const port = await getPort();
    expect(port).toBe(4000);
  });

  it('should return a valid port when no port env vars are set', async () => {
    delete process.env.ARCHON_PORT;
    delete process.env.PORT;
    // Note: If running in a worktree, port will be auto-allocated (base 3090 + offset 100-999)
    // If running in main repo, port will be 3090
    const port = await getPort();
    const basePort = 3090;
    const maxPort = basePort + 999;
    expect(port).toBeGreaterThanOrEqual(basePort);
    expect(port).toBeLessThanOrEqual(maxPort);
  });
});

describe('getPort - invalid port env vars', () => {
  const originalPort = process.env.PORT;
  const originalArchonPort = process.env.ARCHON_PORT;
  let exitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    exitSpy = spyOn(process, 'exit').mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    if (originalPort === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = originalPort;
    }
    if (originalArchonPort === undefined) {
      delete process.env.ARCHON_PORT;
    } else {
      process.env.ARCHON_PORT = originalArchonPort;
    }
    exitSpy.mockRestore();
  });

  it('should exit with code 1 when ARCHON_PORT is not a valid port number', async () => {
    process.env.ARCHON_PORT = 'abc';
    delete process.env.PORT;
    await getPort();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should exit with code 1 when PORT is not a valid port number and ARCHON_PORT is unset', async () => {
    delete process.env.ARCHON_PORT;
    process.env.PORT = 'not-a-port';
    await getPort();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// Integration test notes (manual verification):
// 1. Run in main repo: `bun dev` → should use port 3090 with log {"port":3090} "default_port_selected"
// 2. Run in worktree: `bun dev` → should auto-allocate port 3XXX with "worktree_port_allocated" log
// 3. Override: `PORT=4000 bun dev` → should use 4000 (both contexts)
// 4. Override: `ARCHON_PORT=4500 PORT=4000 bun dev` → should use 4500 (ARCHON_PORT takes priority)
// 5. Multiple worktrees: Start in 2+ worktrees → different ports
// 6. Invalid port: `ARCHON_PORT=abc bun dev` → should exit with fatal log and code 1
