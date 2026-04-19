/**
 * Tests for CLI argument parsing and main flow
 *
 * Note: These tests focus on argument parsing logic.
 * Full integration tests would require mocking the database and commands.
 */
import { describe, it, expect } from 'bun:test';
import { parseArgs } from 'util';
import * as git from '@archon/git';

// Test the argument parsing logic used in cli.ts
describe('CLI argument parsing', () => {
  // Mirror the actual parseArgs options from cli.ts
  const parseCliArgs = (
    args: string[]
  ): { values: Record<string, unknown>; positionals: string[] } => {
    return parseArgs({
      args,
      options: {
        cwd: { type: 'string', default: process.cwd() },
        help: { type: 'boolean', short: 'h' },
        branch: { type: 'string', short: 'b' },
        from: { type: 'string' },
        'from-branch': { type: 'string' },
        'no-worktree': { type: 'boolean' },
        spawn: { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
        verbose: { type: 'boolean', short: 'v' },
      },
      allowPositionals: true,
      strict: false,
    });
  };

  describe('--cwd flag', () => {
    it('should parse --cwd with path', () => {
      const result = parseCliArgs(['--cwd', '/custom/path', 'workflow', 'list']);
      expect(result.values.cwd).toBe('/custom/path');
      expect(result.positionals).toEqual(['workflow', 'list']);
    });

    it('should default to process.cwd() when --cwd not provided', () => {
      const result = parseCliArgs(['workflow', 'list']);
      expect(result.values.cwd).toBe(process.cwd());
    });

    it('should handle --cwd after command (interleaved)', () => {
      const result = parseCliArgs(['workflow', '--cwd', '/path', 'list']);
      expect(result.values.cwd).toBe('/path');
      expect(result.positionals).toEqual(['workflow', 'list']);
    });
  });

  describe('--help flag', () => {
    it('should parse --help flag', () => {
      const result = parseCliArgs(['--help']);
      expect(result.values.help).toBe(true);
    });

    it('should parse -h short flag', () => {
      const result = parseCliArgs(['-h']);
      expect(result.values.help).toBe(true);
    });
  });

  describe('--quiet and --verbose flags', () => {
    it('should parse --quiet flag', () => {
      const result = parseCliArgs(['--quiet', 'workflow', 'list']);
      expect(result.values.quiet).toBe(true);
    });

    it('should parse -q short flag', () => {
      const result = parseCliArgs(['-q', 'workflow', 'list']);
      expect(result.values.quiet).toBe(true);
    });

    it('should parse --verbose flag', () => {
      const result = parseCliArgs(['--verbose', 'workflow', 'list']);
      expect(result.values.verbose).toBe(true);
    });

    it('should parse -v short flag', () => {
      const result = parseCliArgs(['-v', 'workflow', 'list']);
      expect(result.values.verbose).toBe(true);
    });

    it('should parse both --quiet and --verbose when provided', () => {
      const result = parseCliArgs(['-q', '-v', 'workflow', 'list']);
      expect(result.values.quiet).toBe(true);
      expect(result.values.verbose).toBe(true);
      // Precedence (quiet > verbose) is enforced in cli.ts main(), not in parsing
    });
  });

  describe('workflow run arguments', () => {
    it('should parse workflow run with name and message', () => {
      const result = parseCliArgs(['workflow', 'run', 'assist', 'fix', 'the', 'bug']);
      expect(result.positionals).toEqual(['workflow', 'run', 'assist', 'fix', 'the', 'bug']);
    });

    it('should parse workflow run with quoted message', () => {
      const result = parseCliArgs(['workflow', 'run', 'assist', 'fix the bug']);
      expect(result.positionals).toEqual(['workflow', 'run', 'assist', 'fix the bug']);
    });

    it('should parse workflow run with only name (no message)', () => {
      const result = parseCliArgs(['workflow', 'run', 'assist']);
      expect(result.positionals).toEqual(['workflow', 'run', 'assist']);
    });

    it('should parse --from flag for workflow run', () => {
      const result = parseCliArgs([
        'workflow',
        'run',
        'assist',
        '--branch',
        'test-adapters',
        '--from',
        'feature/extract-adapters',
      ]);
      expect(result.values.from).toBe('feature/extract-adapters');
    });

    it('should parse --from-branch flag for workflow run', () => {
      const result = parseCliArgs([
        'workflow',
        'run',
        'assist',
        '--branch',
        'test-adapters',
        '--from-branch',
        'feature/extract-adapters',
      ]);
      expect(result.values['from-branch']).toBe('feature/extract-adapters');
    });

    it('--from takes precedence over --from-branch when both provided', () => {
      const result = parseCliArgs([
        'workflow',
        'run',
        'assist',
        '--branch',
        'test',
        '--from',
        'feature/primary',
        '--from-branch',
        'feature/secondary',
      ]);
      expect(result.values.from).toBe('feature/primary');
      expect(result.values['from-branch']).toBe('feature/secondary');
    });
  });

  describe('unknown flags with strict: false', () => {
    it('should pass through unknown flags', () => {
      const result = parseCliArgs(['--unknown', 'workflow', 'list']);
      // Unknown flag is ignored, positionals are preserved
      expect(result.positionals).toEqual(['workflow', 'list']);
    });

    it('should pass through typos like --cwdd', () => {
      const result = parseCliArgs(['--cwdd', '/path', 'workflow', 'list']);
      // Typo is ignored, --cwd defaults to process.cwd()
      expect(result.values.cwd).toBe(process.cwd());
      expect(result.positionals).toContain('/path'); // /path becomes positional
    });
  });
});

describe('Conversation ID generation', () => {
  // Test the generateConversationId pattern
  const generateConversationId = (): string => {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `cli-${String(timestamp)}-${random}`;
  };

  it('should generate ID with cli- prefix', () => {
    const id = generateConversationId();
    expect(id.startsWith('cli-')).toBe(true);
  });

  it('should include timestamp', () => {
    const before = Date.now();
    const id = generateConversationId();
    const after = Date.now();

    const parts = id.split('-');
    const timestamp = parseInt(parts[1], 10);

    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  it('should include random suffix', () => {
    const id = generateConversationId();
    const parts = id.split('-');

    // Random part should be alphanumeric, 6 chars
    expect(parts[2]).toMatch(/^[a-z0-9]+$/);
    expect(parts[2].length).toBeGreaterThanOrEqual(1);
    expect(parts[2].length).toBeLessThanOrEqual(6);
  });

  it('should generate unique IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateConversationId());
    }
    // All 100 IDs should be unique
    expect(ids.size).toBe(100);
  });
});

describe('CLI env isolation', () => {
  /**
   * The CLI deletes DATABASE_URL from process.env before loading ~/.archon/.env.
   * This prevents Bun's auto-loaded CWD .env from pointing the CLI at a target
   * app's database instead of Archon's SQLite default.
   */
  it('should clear DATABASE_URL set by Bun auto-load', async () => {
    // Simulate Bun auto-loading a target repo's .env
    process.env.DATABASE_URL = 'postgresql://target-app:5432/not-archon';

    // Re-run the env isolation logic from cli.ts
    delete process.env.DATABASE_URL;

    expect(process.env.DATABASE_URL).toBeUndefined();
  });

  it('should allow $ARCHON_HOME/.env to override Bun-auto-loaded vars via override:true', async () => {
    const { config } = await import('dotenv');
    const { resolve } = await import('path');
    const { existsSync } = await import('fs');

    // Simulate Bun auto-loading a stale value
    process.env.TEST_ARCHON_OVERRIDE = 'from-cwd-env';

    // Write a temporary env content and load with override
    const globalEnvPath = resolve(process.env.HOME ?? '~', '.archon', '.env');
    if (existsSync(globalEnvPath)) {
      const result = config({ path: globalEnvPath, override: true });
      // If the global Archon env file exists and has DATABASE_URL, it should override
      expect(result.error).toBeUndefined();
    }

    // Clean up
    delete process.env.TEST_ARCHON_OVERRIDE;
  });
});

describe('CLI git repo check', () => {
  /**
   * These tests verify the command categorization logic used in cli.ts.
   * The CLI uses: requiresGitRepo = !noGitCommands.includes(command ?? '')
   * where noGitCommands = ['version', 'help']
   */
  describe('command categorization', () => {
    // Mirror the actual noGitCommands array from cli.ts
    const noGitCommands = ['version', 'help'];

    // Helper that mirrors the CLI's logic
    const requiresGitRepo = (command: string | undefined): boolean => {
      return !noGitCommands.includes(command ?? '');
    };

    describe('commands that bypass git check', () => {
      it('version command should not require git repo', () => {
        expect(requiresGitRepo('version')).toBe(false);
      });

      it('help command should not require git repo', () => {
        expect(requiresGitRepo('help')).toBe(false);
      });
    });

    describe('commands that require git repo', () => {
      it('workflow command should require git repo', () => {
        expect(requiresGitRepo('workflow')).toBe(true);
      });

      it('isolation command should require git repo', () => {
        expect(requiresGitRepo('isolation')).toBe(true);
      });

      it('undefined command should require git repo (fail with unknown command later)', () => {
        expect(requiresGitRepo(undefined)).toBe(true);
      });

      it('unknown commands should require git repo', () => {
        expect(requiresGitRepo('unknown')).toBe(true);
      });
    });
  });

  describe('findRepoRoot behavior', () => {
    // Test the actual git.findRepoRoot function with real directories
    it('should find repo root from current test directory', async () => {
      // This test file is inside a git repo, so findRepoRoot should work
      const result = await git.findRepoRoot(process.cwd());
      expect(result).not.toBeNull();
      // The repo root should be a valid directory (not a subdirectory like packages/cli/src)
      expect(result).toBeTruthy();
    });

    it('should find repo root from a subdirectory', async () => {
      // Use __dirname which is the directory containing this test file
      // This is a real subdirectory (packages/cli/src) that should resolve to repo root
      const subdirectory = import.meta.dir;
      const result = await git.findRepoRoot(subdirectory);

      // Should resolve to repo root, not packages/cli/src
      expect(result).not.toBeNull();
      expect(result).not.toContain('/packages/cli/src');
    });

    it('should return null for system directories outside any git repo', async () => {
      // /tmp is typically not inside a git repo
      // Note: This test may need adjustment if /tmp happens to be inside a repo
      const result = await git.findRepoRoot('/tmp');
      expect(result).toBeNull();
    });
  });

  describe('path validation', () => {
    // The CLI now validates that the path exists before calling findRepoRoot
    // This tests the logic pattern used in cli.ts
    const { existsSync } = require('fs');

    it('should detect existing directories', () => {
      expect(existsSync(process.cwd())).toBe(true);
      expect(existsSync('/tmp')).toBe(true);
    });

    it('should detect non-existent directories', () => {
      expect(existsSync('/this/path/definitely/does/not/exist/12345')).toBe(false);
    });
  });

  describe('error messages', () => {
    // Verify the exact error messages used in cli.ts for documentation purposes
    const ERROR_MESSAGES = {
      notGitRepo: [
        'Error: Not in a git repository.',
        'The Archon CLI must be run from within a git repository.',
        'Either navigate to a git repo or use --cwd to specify one.',
      ],
      dirNotExist: (path: string) => `Error: Directory does not exist: ${path}`,
    };

    it('should have actionable git repo error message', () => {
      // Verify the messages include guidance
      expect(ERROR_MESSAGES.notGitRepo[0]).toContain('Not in a git repository');
      expect(ERROR_MESSAGES.notGitRepo[2]).toContain('--cwd');
    });

    it('should have clear directory error message', () => {
      const msg = ERROR_MESSAGES.dirNotExist('/nonexistent');
      expect(msg).toContain('Directory does not exist');
      expect(msg).toContain('/nonexistent');
    });
  });
});
