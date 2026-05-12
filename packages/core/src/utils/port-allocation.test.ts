import { describe, it, expect, afterEach } from 'bun:test';
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
  const originalEnv = process.env.PORT;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = originalEnv;
    }
  });

  it('should return PORT env var when explicitly set to valid number', async () => {
    process.env.PORT = '4000';
    const port = await getPort();
    expect(port).toBe(4000);
  });

  it('should return a valid port when no PORT env is set', async () => {
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

// Integration test notes (manual verification):
// 1. Run in main repo: `bun dev` → should use port 3000 with log "Using default port"
// 2. Run in worktree: `bun dev` → should auto-allocate port 3XXX with "Worktree detected" log
// 3. Override: `PORT=4000 bun dev` → should use 4000 (both contexts)
// 4. Multiple worktrees: Start in 2+ worktrees → different ports
// 5. Invalid PORT: `PORT=abc bun dev` → should exit with error message
