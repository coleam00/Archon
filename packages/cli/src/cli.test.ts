/**
 * Tests for CLI argument parsing and main flow
 *
 * Note: These tests focus on argument parsing logic.
 * Full integration tests would require mocking the database and commands.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { parseArgs } from 'util';
import { cliArgOptions } from './args';
import * as git from '@archon/git';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sealWorkflowRunConfig } from '@archon/core/config';
import {
  rejectConfigOnContinue,
  rejectConfigOutsideRun,
  rejectModelOnContinue,
} from './dispatch-guards';

const CLI_ENTRY = join(import.meta.dir, 'cli.ts');
// The enclosing git worktree — a valid repo for the git gate, with a real
// .archon/workflows/ directory so an unknown workflow name fails deterministically.
const repoRoot = join(import.meta.dir, '..', '..', '..');

describe('CLI help output', () => {
  // The five tests assert disjoint fragments of one static usage string, so a
  // single captured `--help` spawn replaces five identical interpreter
  // startups; every assertion below is unchanged.
  let help: { status: number | null; stdout: string };
  beforeAll(() => {
    const result = spawnSync(process.execPath, [CLI_ENTRY, '--help'], {
      encoding: 'utf8',
      env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1' },
    });
    help = { status: result.status, stdout: result.stdout ?? '' };
  });

  it('lists the workflow resume command', () => {
    expect(help.status).toBe(0);
    expect(help.stdout).toContain(
      'workflow resume <run-id>   Resume a failed or paused run from completed nodes'
    );
  });

  it('distinguishes active cancel from state-only abandon', () => {
    expect(help.status).toBe(0);
    expect(help.stdout).toContain(
      'workflow cancel <run-id>   Stop a running workflow started with --detach'
    );
    expect(help.stdout).toContain(
      'workflow abandon <run-id>  Mark a run cancelled without stopping host work'
    );
  });

  it('documents workflow dry-run flags', () => {
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--dry-run');
    expect(help.stdout).toContain('--stubs <path>');
    expect(help.stdout).toContain('--stubs-init <path>');
    expect(help.stdout).toContain('--default-stubs');
    expect(help.stdout).toContain('--exec-code');
    expect(help.stdout).toContain('--pause-at-gates');
  });

  it('documents sparse repeatable model bindings', () => {
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--model <name>=<spec>');
  });

  it('documents the per-run config file', () => {
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--config <path>');
  });

  it('documents the unified skill destinations and subscription providers', () => {
    expect(help.status).toBe(0);
    expect(help.stdout).toContain(
      'skill install [path]       Install archon-cli into .claude/skills and .agents/skills'
    );
    expect(help.stdout).toContain(
      'ai login <provider>        Connect a Claude, ChatGPT/Codex, or Copilot subscription'
    );
  });
});

describe('workflow model arguments', () => {
  it('parses repeated --model values without accepting a coarse provider flag', () => {
    const parsed = parseArgs({
      args: ['workflow', 'run', 'x', '--model', 'large=openai/gpt-5.6', '--model', '@p=large'],
      options: cliArgOptions,
      allowPositionals: true,
      strict: true,
    });
    expect(parsed.values.model).toEqual(['large=openai/gpt-5.6', '@p=large']);
    expect(() =>
      parseArgs({
        args: ['workflow', 'run', 'x', '--provider', 'pi'],
        options: cliArgOptions,
        allowPositionals: true,
        strict: true,
      })
    ).toThrow(/provider/);
  });

  for (const args of [
    ['workflow', 'resume', 'run-1'],
    ['workflow', 'approve', 'run-1'],
    ['workflow', 'reject', 'run-1'],
    ['workflow', 'respond', 'run-1', 'approve'],
  ]) {
    it(`rejects --model on ${args[0]} ${args[1]}`, () => {
      // Pure pre-dispatch argv guard — no I/O, so asserted in-process instead
      // of through a full interpreter startup. A defined message is what makes
      // main() print to stderr and exit 1.
      const message = rejectModelOnContinue(args[1], 'large=opus');
      expect(message).toBeDefined();
      expect(message).toContain('--model cannot be used when continuing an existing workflow run');
      expect(message).toContain('keeps the model bindings it started with');
    });
  }
});

describe('workflow run config argument', () => {
  it('parses one local path', () => {
    const parsed = parseArgs({
      args: ['workflow', 'run', 'x', '--config', './config.minimax.yaml'],
      options: cliArgOptions,
      allowPositionals: true,
      strict: true,
    });
    expect(parsed.values.config).toBe('./config.minimax.yaml');
  });

  it('rejects a new config on run --resume before reading it', () => {
    // Pure pre-dispatch argv guard — no I/O, so asserted in-process.
    const message = rejectConfigOnContinue(true, './does-not-exist.yaml');
    expect(message).toBeDefined();
    expect(message).toContain('--config cannot be used when continuing');
  });

  it('rejects --config outside workflow run before dispatch', () => {
    // Pure pre-dispatch argv guard — no I/O, so asserted in-process.
    const message = rejectConfigOutsideRun('chat', undefined, './does-not-exist.yaml');
    expect(message).toBeDefined();
    expect(message).toContain('--config can only be used with workflow run');
  });

  it('resolves a relative config path from the requested subdirectory cwd', () => {
    const repo = mkdtempSync(join(tmpdir(), 'archon-cli-config-cwd-'));
    const subdir = join(repo, 'bench');
    mkdirSync(subdir, { recursive: true });
    spawnSync('git', ['init'], { cwd: repo, encoding: 'utf8' });
    writeFileSync(join(subdir, 'config.yaml'), 'paths: {}\n');

    try {
      const result = spawnSync(
        process.execPath,
        [CLI_ENTRY, 'workflow', 'run', 'x', '--cwd', subdir, '--config', './config.yaml'],
        { encoding: 'utf8' }
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Run config key 'paths' cannot apply");
      expect(result.stderr).not.toContain('Unable to read run config');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('keeps a detached config handoff outside repo env overrides', () => {
    const repo = mkdtempSync(join(tmpdir(), 'archon-cli-detached-config-'));
    const archonHome = join(repo, 'archon-home');
    mkdirSync(join(repo, '.archon'), { recursive: true });
    spawnSync('git', ['init', '-q', '.'], { cwd: repo });
    writeFileSync(
      join(repo, '.env'),
      `TOKEN_ENCRYPTION_KEY=${'33'.repeat(32)}\n` +
        `ARCHON_HOME=${join(repo, 'wrong-home')}\n` +
        'ARCHON_DOCKER=true\n' +
        'WORKSPACE_PATH=/workspace\n' +
        'HOME=/root\n'
    );
    writeFileSync(
      join(repo, '.archon', '.env'),
      `TOKEN_ENCRYPTION_KEY=${'22'.repeat(32)}\n` +
        'ARCHON_DOCKER=true\n' +
        'WORKSPACE_PATH=/workspace\n' +
        'HOME=/root\n'
    );

    const savedKey = process.env.TOKEN_ENCRYPTION_KEY;
    const savedArchonHome = process.env.ARCHON_HOME;
    delete process.env.TOKEN_ENCRYPTION_KEY;
    process.env.ARCHON_HOME = relative(process.cwd(), archonHome);
    const payload = JSON.stringify(
      sealWorkflowRunConfig({ docsPath: 'accepted' }, { kind: 'cli', label: 'config.minimax.yaml' })
    );
    if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
    if (savedArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = savedArchonHome;

    try {
      const result = spawnSync(
        process.execPath,
        [
          CLI_ENTRY,
          'workflow',
          'run',
          'x',
          '--dry-run',
          '--resume',
          '--internal-detached-run-config',
          payload,
        ],
        {
          cwd: repo,
          encoding: 'utf8',
          env: {
            ...process.env,
            ARCHON_HOME: archonHome,
            TOKEN_ENCRYPTION_KEY: '',
            ARCHON_DOCKER: '',
            WORKSPACE_PATH: '',
            HOME: homedir(),
          },
        }
      );
      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('could not be decrypted');
      expect(result.stderr).toContain('--resume and --config are mutually exclusive');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('keeps a detached Docker install classified through target env loading', () => {
    const repo = mkdtempSync(join(tmpdir(), 'archon-cli-detached-docker-'));
    mkdirSync(join(repo, '.archon'), { recursive: true });
    writeFileSync(
      join(repo, '.env'),
      `TOKEN_ENCRYPTION_KEY=${'33'.repeat(32)}\n` +
        `ARCHON_HOME=${join(repo, 'wrong-home')}\n` +
        'ARCHON_DOCKER=false\n' +
        'WORKSPACE_PATH=\n' +
        `HOME=${repo}\n`
    );
    writeFileSync(
      join(repo, '.archon', '.env'),
      `TOKEN_ENCRYPTION_KEY=${'22'.repeat(32)}\n` +
        `ARCHON_HOME=${join(repo, 'wrong-home')}\n` +
        'ARCHON_DOCKER=false\n' +
        'WORKSPACE_PATH=\n' +
        `HOME=${repo}\n`
    );

    const stripBootUrl = pathToFileURL(
      join(repoRoot, 'packages', 'paths', 'src', 'strip-cwd-env-boot.ts')
    ).href;
    const pathsUrl = pathToFileURL(join(repoRoot, 'packages', 'paths', 'src', 'index.ts')).href;
    const probe = join(repo, 'probe.ts');
    writeFileSync(
      probe,
      `import '${stripBootUrl}';\n` +
        `import { captureDetachedInstallContext, getArchonHome, isDocker, loadArchonEnv, restoreDetachedInstallContext } from '${pathsUrl}';\n` +
        'const inherited = captureDetachedInstallContext();\n' +
        'loadArchonEnv(process.cwd());\n' +
        'restoreDetachedInstallContext(inherited);\n' +
        'process.stdout.write(JSON.stringify({ docker: isDocker(), home: getArchonHome(), context: inherited }));\n'
    );

    try {
      const result = spawnSync(
        process.execPath,
        [probe, '--internal-detached-run-config', 'placeholder'],
        {
          cwd: repo,
          encoding: 'utf8',
          env: {
            ...process.env,
            TOKEN_ENCRYPTION_KEY: 'parent-key',
            ARCHON_HOME: '/.archon',
            ARCHON_DOCKER: 'true',
            WORKSPACE_PATH: '/workspace',
            HOME: '/root',
          },
        }
      );
      expect({ status: result.status, stderr: result.stderr }).toEqual({
        status: 0,
        stderr: expect.stringContaining('[archon] stripped 5 keys'),
      });
      expect(JSON.parse(result.stdout)).toEqual({
        docker: true,
        home: '/.archon',
        context: {
          TOKEN_ENCRYPTION_KEY: 'parent-key',
          ARCHON_HOME: '/.archon',
          ARCHON_DOCKER: 'true',
          WORKSPACE_PATH: '/workspace',
          HOME: '/root',
        },
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  for (const args of [
    ['workflow', 'resume', 'run-1'],
    ['workflow', 'approve', 'run-1'],
    ['workflow', 'reject', 'run-1'],
    ['workflow', 'respond', 'run-1', 'approve'],
  ]) {
    it(`rejects --config on ${args[0]} ${args[1]}`, () => {
      // Pure pre-dispatch argv guard — no I/O, so asserted in-process instead
      // of through a full interpreter startup.
      const message = rejectConfigOutsideRun(args[0], args[1], './config.minimax.yaml');
      expect(message).toBeDefined();
      expect(message).toContain('--config can only be used with workflow run');
    });
  }
});

describe('unknown flag rejection (#2769)', () => {
  it('exits non-zero naming the mistyped flag before any command runs', () => {
    const result = spawnSync(
      process.execPath,
      [CLI_ENTRY, 'workflow', 'run', 'assist', '--dryrun', '--stubs', 'x.yaml'],
      { encoding: 'utf8' }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--dryrun');
  });

  it('still accepts a valid workflow dry-run invocation', () => {
    const result = spawnSync(
      process.execPath,
      [CLI_ENTRY, 'workflow', 'run', 'definitely-not-a-workflow', '--dry-run'],
      { encoding: 'utf8', cwd: join(import.meta.dir, '../../../') }
    );

    // Fails on the unknown workflow name (after parsing), not on the flag.
    expect(result.stderr).not.toContain('Error parsing arguments');
  });
});

describe('workflow status arguments', () => {
  it('rejects a run id and points to workflow get', () => {
    const result = spawnSync(
      process.execPath,
      [join(import.meta.dir, 'cli.ts'), 'workflow', 'status', 'abc123'],
      { encoding: 'utf8' }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Usage: archon workflow status [--json] [--verbose] [--events]'
    );
    expect(result.stderr).toContain('archon workflow get <run-id>');
    expect(result.stdout).toBe('');
  });
});

describe('workflow get arguments', () => {
  it('rejects extra positional arguments', () => {
    const result = spawnSync(
      process.execPath,
      [join(import.meta.dir, 'cli.ts'), 'workflow', 'get', 'abc123', 'accidental-extra'],
      { encoding: 'utf8' }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Usage: archon workflow get <run-id> [--json] [--verbose] [--events]'
    );
    expect(result.stdout).toBe('');
  });
});

describe('CLI workflow event dispatch', () => {
  it('resolves a run prefix using the registered effective cwd', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'archon-cli-event-'));
    const archonHome = join(scratch, 'home');
    const repoDir = join(scratch, 'repo');
    mkdirSync(archonHome, { recursive: true });
    mkdirSync(repoDir, { recursive: true });

    try {
      expect(spawnSync('git', ['init', '-q', '.'], { cwd: repoDir }).status).toBe(0);
      const repoRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: repoDir,
        encoding: 'utf8',
      });
      expect(repoRoot.status).toBe(0);

      const env = {
        ...process.env,
        ARCHON_HOME: archonHome,
        ARCHON_TELEMETRY_DISABLED: '1',
      };
      const initialize = spawnSync(
        process.execPath,
        [CLI_ENTRY, 'workflow', 'status', '--cwd', repoDir],
        { env, encoding: 'utf8' }
      );
      expect({ status: initialize.status, stderr: initialize.stderr }).toEqual({
        status: 0,
        stderr: '',
      });

      const fullRunId = '0b1ee8da-1111-2222-3333-444455556666';
      const database = new Database(join(archonHome, 'archon.db'));
      try {
        database.run(
          'INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES (?, ?, ?)',
          ['codebase-1', 'fixture', repoRoot.stdout.trim()]
        );
        database.run(
          'INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id, codebase_id) VALUES (?, ?, ?, ?)',
          ['conversation-1', 'cli', 'cli-fixture', 'codebase-1']
        );
        database.run(
          'INSERT INTO remote_agent_workflow_runs (id, conversation_id, codebase_id, workflow_name, user_message) VALUES (?, ?, ?, ?, ?)',
          [fullRunId, 'conversation-1', 'codebase-1', 'fixture', 'test']
        );
      } finally {
        database.close();
      }

      const emitted = spawnSync(
        process.execPath,
        [
          CLI_ENTRY,
          'workflow',
          'event',
          'emit',
          '--run-id',
          fullRunId.slice(0, 8),
          '--type',
          'workflow_started',
          '--cwd',
          repoDir,
        ],
        { env, encoding: 'utf8' }
      );
      expect({ status: emitted.status, stderr: emitted.stderr }).toEqual({ status: 0, stderr: '' });

      const verify = new Database(join(archonHome, 'archon.db'), { readonly: true });
      try {
        const event = verify
          .query<
            { workflow_run_id: string; event_type: string },
            []
          >('SELECT workflow_run_id, event_type FROM remote_agent_workflow_events')
          .get();
        expect(event).toEqual({
          workflow_run_id: fullRunId,
          event_type: 'workflow_started',
        });
      } finally {
        verify.close();
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});

// Test the argument parsing logic used in cli.ts
describe('CLI argument parsing', () => {
  const parseCliArgs = (
    args: string[]
  ): { values: Record<string, unknown>; positionals: string[] } => {
    return parseArgs({
      args,
      options: cliArgOptions,
      allowPositionals: true,
      strict: true,
    });
  };

  describe('isolation cleanup flags', () => {
    it('parses --merged and --include-closed in strict mode', () => {
      const { values } = parseCliArgs(['isolation', 'cleanup', '--merged', '--include-closed']);
      expect(values.merged).toBe(true);
      expect(values['include-closed']).toBe(true);
    });
  });

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

    it('should parse --base flag for workflow run', () => {
      const result = parseCliArgs(['workflow', 'run', 'assist', '--base', 'epic/foo']);
      expect(result.values.base).toBe('epic/foo');
    });

    it('parses workflow dry-run flags', () => {
      const result = parseCliArgs([
        'workflow',
        'run',
        'assist',
        '--dry-run',
        '--stubs',
        'fixtures.yaml',
        '--stubs-init',
        'generated.yaml',
        '--default-stubs',
        '--exec-code',
        '--pause-at-gates',
      ]);

      expect(result.values['dry-run']).toBe(true);
      expect(result.values.stubs).toBe('fixtures.yaml');
      expect(result.values['stubs-init']).toBe('generated.yaml');
      expect(result.values['default-stubs']).toBe(true);
      expect(result.values['exec-code']).toBe(true);
      expect(result.values['pause-at-gates']).toBe(true);
    });
  });

  describe('version flag detection', () => {
    /**
     * Duplicates the isVersionRequest() helper from cli.ts (which is not
     * exported — importing cli.ts would execute its top-level main()). Must
     * be updated manually if the source logic changes.
     */
    const isVersionRequest = (args: string[]): boolean => {
      if (args.length === 1 && args[0] === '-v') return true;
      for (const arg of args) {
        if (arg === '--version' || arg === '-V' || arg === '-version') return true;
      }
      return false;
    };

    it('detects --version', () => {
      expect(isVersionRequest(['--version'])).toBe(true);
    });

    it('detects -V (uppercase short flag)', () => {
      expect(isVersionRequest(['-V'])).toBe(true);
    });

    it('detects -version (single-dash typo)', () => {
      expect(isVersionRequest(['-version'])).toBe(true);
    });

    it('treats lone -v as a version request', () => {
      expect(isVersionRequest(['-v'])).toBe(true);
    });

    it('treats -v with other args as --verbose (NOT a version request)', () => {
      expect(isVersionRequest(['-v', 'workflow', 'list'])).toBe(false);
      expect(isVersionRequest(['workflow', '-v', 'list'])).toBe(false);
    });

    it('does not treat the literal "version" command as a flag-style request', () => {
      // The `version` positional command is handled by the existing switch,
      // not the early flag bypass. isVersionRequest should not match it.
      expect(isVersionRequest(['version'])).toBe(false);
    });

    it('detects --version anywhere in argv', () => {
      expect(isVersionRequest(['--cwd', '/foo', '--version'])).toBe(true);
    });

    it('returns false for unrelated args', () => {
      expect(isVersionRequest(['workflow', 'list'])).toBe(false);
      expect(isVersionRequest(['help'])).toBe(false);
      expect(isVersionRequest([])).toBe(false);
    });
  });

  describe('unknown flags (#2769)', () => {
    it('rejects an unknown flag instead of dropping it', () => {
      expect(() => parseCliArgs(['--unknown', 'workflow', 'list'])).toThrow(/unknown option/i);
    });

    it('rejects a typoed flag like --cwdd', () => {
      expect(() => parseCliArgs(['--cwdd', '/path', 'workflow', 'list'])).toThrow(/--cwdd/);
    });
  });

  describe('setup --scope and --force flags (#1303)', () => {
    it('parses --scope home', () => {
      const result = parseCliArgs(['setup', '--scope', 'home']);
      expect(result.values.scope).toBe('home');
    });

    it('parses --scope project', () => {
      const result = parseCliArgs(['setup', '--scope', 'project']);
      expect(result.values.scope).toBe('project');
    });

    it('defaults --scope to undefined when not provided', () => {
      const result = parseCliArgs(['setup']);
      expect(result.values.scope).toBeUndefined();
    });

    it('parses --force as boolean', () => {
      const result = parseCliArgs(['setup', '--force']);
      expect(result.values.force).toBe(true);
    });

    it('captures an invalid --scope value verbatim for caller validation', () => {
      // parseArgs itself does not validate the enum; cli.ts validates and
      // exits on unknown scope values. The test documents the contract.
      const result = parseCliArgs(['setup', '--scope', 'nonsense']);
      expect(result.values.scope).toBe('nonsense');
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

  it('should allow ~/.archon/.env to override Bun-auto-loaded vars via override:true', async () => {
    const { config } = await import('dotenv');
    const { resolve } = await import('path');
    const { existsSync } = await import('fs');

    // Simulate Bun auto-loading a stale value
    process.env.TEST_ARCHON_OVERRIDE = 'from-cwd-env';

    // Write a temporary env content and load with override
    const globalEnvPath = resolve(process.env.HOME ?? '~', '.archon', '.env');
    if (existsSync(globalEnvPath)) {
      const result = config({ path: globalEnvPath, override: true });
      // If ~/.archon/.env exists and has DATABASE_URL, it should override
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
      // The OS temp dir is not inside a git repo on any supported platform.
      // Hardcoding '/tmp' fails on Windows, where that path does not exist —
      // this file was absent from the package test script until #2384, so the
      // POSIX assumption never surfaced in CI.
      const result = await git.findRepoRoot(tmpdir());
      expect(result).toBeNull();
    });
  });

  describe('path validation', () => {
    // The CLI now validates that the path exists before calling findRepoRoot
    // This tests the logic pattern used in cli.ts
    const { existsSync } = require('fs');

    it('should detect existing directories', () => {
      expect(existsSync(process.cwd())).toBe(true);
      expect(existsSync(tmpdir())).toBe(true);
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

// All --json error-envelope tests share one contract: exit 1 and a parseable
// `{ ok: false }` payload on stdout via the shared writeJsonLine catch path.
// One helper owns the spawn env and envelope access so every case pays setup
// once instead of repeating it; each test still drives its own invocation so
// the subprocess stdout/exit-code contract stays covered.
function spawnJsonError(argv: string[], extraEnv: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...argv], {
    encoding: 'utf8',
    env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1', ...extraEnv },
  });
  return { status: result.status, envelope: () => JSON.parse(result.stdout ?? '') };
}

describe('workflow search --json error envelope', () => {
  it('emits { ok: false } on stdout when the command throws under --json', () => {
    // An unreachable marketplace URL makes fetchMarketplace throw inside the
    // `workflow search` handler — the only deterministic error path. The
    // envelope, not the message, is the contract.
    const { status, envelope } = spawnJsonError(['workflow', 'search', 'anything', '--json'], {
      ARCHON_MARKETPLACE_URL: 'http://127.0.0.1:9/nope',
    });

    expect(status).toBe(1);
    expect(envelope).not.toThrow();
    expect(envelope()).toMatchObject({ ok: false });
  });
});

describe('main catch --json error envelope', () => {
  it('emits { ok: false } on stdout when an unhandled command error reaches the top-level catch', () => {
    // An unknown workflow name makes workflowRunCommand throw with no local
    // handling, so the error escapes to main()'s outer catch — the last route
    // that could still leak bare stderr text under --json.
    const { status, envelope } = spawnJsonError([
      'workflow',
      'run',
      'definitely-not-a-workflow',
      '--json',
      '--cwd',
      repoRoot,
    ]);

    expect(status).toBe(1);
    expect(envelope).not.toThrow();
    expect(envelope()).toMatchObject({ ok: false });
  });
});

describe('pre-dispatch gates --json error envelope', () => {
  it('emits { ok: false } on stdout when --cwd does not exist', () => {
    const { status, envelope } = spawnJsonError([
      'workflow',
      'run',
      'anything',
      '--json',
      '--cwd',
      '/does/not/exist',
    ]);

    expect(status).toBe(1);
    expect(envelope).not.toThrow();
    expect(envelope()).toMatchObject({ ok: false });
  });

  it('emits { ok: false } on stdout when outside a git repository', () => {
    const { status, envelope } = spawnJsonError(['workflow', 'list', '--json', '--cwd', tmpdir()]);

    expect(status).toBe(1);
    expect(envelope).not.toThrow();
    expect(envelope()).toMatchObject({ ok: false });
  });

  it('emits { ok: false } on stdout for an unknown command instead of usage text', () => {
    const { status, envelope } = spawnJsonError(['boguscmd', '--json']);

    expect(status).toBe(1);
    expect(envelope).not.toThrow();
    expect(envelope()).toMatchObject({ ok: false });
  });

  it('emits { ok: false } on stdout when arg parsing rejects an unknown flag', () => {
    const { status, envelope } = spawnJsonError(['workflow', 'list', '--json', '--bogus-flag']);

    expect(status).toBe(1);
    expect(envelope).not.toThrow();
    expect(envelope()).toMatchObject({ ok: false });
  });

  it('emits { ok: false } on stdout when chat is invoked with no message', () => {
    const { status, envelope } = spawnJsonError(['chat', '--json']);

    expect(status).toBe(1);
    expect(envelope).not.toThrow();
    expect(envelope()).toMatchObject({ ok: false });
  });

  it('emits { ok: false } on stdout for an invalid setup --scope', () => {
    const { status, envelope } = spawnJsonError(['setup', '--scope', 'bogus', '--json']);

    expect(status).toBe(1);
    expect(envelope).not.toThrow();
    expect(envelope()).toMatchObject({ ok: false });
  });

  it('emits { ok: false } on stdout when workflow get is missing its run-id', () => {
    const { status, envelope } = spawnJsonError(['workflow', 'get', '--json']);

    expect(status).toBe(1);
    expect(envelope).not.toThrow();
    expect(envelope()).toMatchObject({ ok: false });
  });

  it('emits { ok: false } on stdout when setup --scope project runs outside a git repo', () => {
    const { status, envelope } = spawnJsonError([
      'setup',
      '--scope',
      'project',
      '--json',
      '--cwd',
      tmpdir(),
    ]);

    expect(status).toBe(1);
    expect(envelope).not.toThrow();
    expect(envelope()).toMatchObject({ ok: false });
  });
});

describe('workflow test --json error envelope', () => {
  it('emits { ok: false } on stdout when the command throws under --json', () => {
    // A --cwd that does not exist makes findRepoRoot throw inside the
    // `workflow test` handler — the only reachable error path without a full
    // fixture project. The envelope, not the message, is the contract.
    const { status, envelope } = spawnJsonError([
      'workflow',
      'test',
      '--json',
      '--cwd',
      join(tmpdir(), 'archon-missing-cwd'),
    ]);

    expect(status).toBe(1);
    expect(envelope).not.toThrow();
    expect(envelope()).toMatchObject({ ok: false });
  });
});
