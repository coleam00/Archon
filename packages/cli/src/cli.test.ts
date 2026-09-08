/**
 * Tests for CLI argument parsing and main flow
 *
 * Note: These tests focus on argument parsing logic.
 * Full integration tests would require mocking the database and commands.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { parseArgs } from 'util';
import { cliArgOptions } from './args';
import * as git from '@archon/git';
import { removeTempTree } from '@archon/paths/test-utils';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

type BuildMetafile = NonNullable<Bun.BuildOutput['metafile']>;

function staticallyReachableInputs(metafile: BuildMetafile, start: string): string[] {
  const pending = [start];
  const visited = new Set<string>();
  const inputs = new Set<string>();

  while (pending.length > 0) {
    const outputPath = pending.pop();
    if (outputPath === undefined || visited.has(outputPath)) continue;
    visited.add(outputPath);

    const output = metafile.outputs[outputPath];
    if (!output) throw new Error(`Build metafile references missing output '${outputPath}'.`);
    for (const input of Object.keys(output.inputs)) inputs.add(input);
    for (const imported of output.imports) {
      if (imported.kind !== 'dynamic-import') pending.push(imported.path);
    }
  }

  return [...inputs].sort();
}

function repositoryInput(path: string): string | undefined {
  const normalized = path.replaceAll('\\', '/');
  const packagesIndex = normalized.indexOf('packages/');
  return packagesIndex === -1 ? undefined : normalized.slice(packagesIndex);
}

function buildImportGraph(entry: string, outdir: string): BuildMetafile {
  const metafilePath = join(outdir, 'metafile.json');
  const result = spawnSync(
    process.execPath,
    [
      'build',
      entry,
      '--target=bun',
      '--format=esm',
      '--splitting',
      `--outdir=${outdir}`,
      `--metafile=${metafilePath}`,
    ],
    { cwd: repoRoot, encoding: 'utf8', timeout: 20000 }
  );
  if (result.status !== 0) {
    throw new Error(`Import graph build failed for ${entry}:\n${result.stdout}\n${result.stderr}`);
  }
  return JSON.parse(readFileSync(metafilePath, 'utf8')) as BuildMetafile;
}

describe('CLI startup import boundary', () => {
  let buildDir: string;
  let metafile: BuildMetafile;
  let handoffMetafile: BuildMetafile;

  beforeAll(() => {
    buildDir = mkdtempSync(join(tmpdir(), 'archon-cli-import-graph-'));
    metafile = buildImportGraph(CLI_ENTRY, join(buildDir, 'cli'));
    // Shared chunks can include unrelated CLI inputs as Bun's splitting changes.
    // An isolated entrypoint measures the decoder's own dependency boundary.
    handoffMetafile = buildImportGraph(
      join(repoRoot, 'packages/core/src/config/run-config-handoff.ts'),
      join(buildDir, 'handoff')
    );
  }, 30000);

  afterAll(async () => {
    if (buildDir) await removeTempTree(buildDir);
  });

  it('keeps help and argument failures outside command, provider, core, workflow, and Git graphs', () => {
    const entry = Object.entries(metafile.outputs).find(([, output]) =>
      output.entryPoint?.replaceAll('\\', '/').endsWith('packages/cli/src/cli.ts')
    )?.[0];
    expect(entry).toBeDefined();

    const forbidden = staticallyReachableInputs(metafile, entry ?? '')
      .map(repositoryInput)
      .filter(
        (input): input is string =>
          input !== undefined &&
          (input.startsWith('packages/cli/src/commands/') ||
            input.startsWith('packages/core/src/') ||
            input.startsWith('packages/git/src/') ||
            input.startsWith('packages/providers/src/') ||
            input.startsWith('packages/workflows/src/'))
      );
    expect(forbidden).toEqual([]);
  });

  it('keeps detached handoff decoding on its audited schema, crypto, and path leaves', () => {
    const internalInputs = Object.keys(handoffMetafile.inputs)
      .map(repositoryInput)
      .filter((input): input is string => input !== undefined)
      .sort();
    expect(internalInputs).toEqual([
      'packages/core/src/config/run-config-handoff.ts',
      'packages/core/src/utils/token-crypto.ts',
      'packages/paths/src/archon-paths.ts',
      'packages/paths/src/effort.ts',
      'packages/paths/src/logger.ts',
      'packages/workflows/src/schemas/durable-wait.ts',
      'packages/workflows/src/schemas/effort.ts',
      'packages/workflows/src/schemas/model-binding.ts',
      'packages/workflows/src/schemas/run-config.ts',
    ]);
  });
});

/**
 * The `Options:` block of a scoped `--help` render, spawned as a subprocess so
 * the assertion sees the real rendered output.
 *
 * Scoped-flag assertions target this slice rather than the whole render. A flag
 * name or wording that also appears in the entry's `spec` or Commands-block
 * description would otherwise keep the test green with the entry's
 * `scopedFlags` deleted, which is the fake guard #3153 recorded for
 * `workflow reset-sessions` and `isolation cleanup --merged`. Deleting a
 * `scopedFlags` entry drops its line from this slice; deleting the whole block
 * suppresses the section and fails the marker assertion below.
 */
function scopedHelpOptions(argv: string[]): string {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...argv, '--help'], {
    encoding: 'utf8',
    env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1' },
  });
  expect(result.status).toBe(0);
  const marker = '\nOptions:\n';
  const start = result.stdout.indexOf(marker);
  expect(start, `no Options block in 'archon ${argv.join(' ')} --help'`).toBeGreaterThanOrEqual(0);
  const body = result.stdout.slice(start + marker.length);
  const end = body.indexOf('\n\n');
  return end === -1 ? body : body.slice(0, end);
}

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

  it('lists the workflow transcript reader and follow flag', () => {
    expect(help.status).toBe(0);
    expect(help.stdout).toContain(
      "workflow logs <run-id>     Print or follow a run's JSONL transcript"
    );
    expect(help.stdout).toContain('--follow');
  });

  it('documents project-scoped active status and its install-wide override', () => {
    expect(help.status).toBe(0);
    expect(help.stdout).toContain(
      'workflow status            Show running/paused workflows for this project'
    );
    expect(help.stdout).toContain(
      "--all                      For 'workflow status/runs': list across all projects"
    );
  });

  it('documents compact and full workflow discovery', () => {
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('workflow list [name] [--full] [--json]');
    expect(help.stdout).toContain('List compact workflow descriptions');
    expect(help.stdout).toContain('Use <name> --full for one exact description');
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

  it('omits the removed branch-inferred continue command', () => {
    expect(help.status).toBe(0);
    expect(help.stdout).not.toMatch(/\bcontinue <branch>/);
    expect(help.stdout).not.toContain('--workflow <name>');
    expect(help.stdout).not.toContain('--no-context');
  });

  it('documents exact run-id adoption as the continuation route', () => {
    expect(help.status).toBe(0);
    expect(help.stdout).toContain(
      "--adopt <run-id>           Start a new run adopting a terminal run's worktree/branch + artifacts ($ADOPTED_RUN_DIR)"
    );
  });

  // Issue #3106 acceptance: scoped `--help` is narrower than the global
  // index. Capture each spawn separately so the two outputs can be compared
  // directly. The global anchor (`--cwd <path>`) must remain in the index and
  // drop from the scoped slice, proving routing is narrowing — not just
  // appending the same content under a different heading.
  it('produces scoped workflow run --help that differs from archon --help and scopes to run-only flags', () => {
    const global = spawnSync(process.execPath, [CLI_ENTRY, '--help'], {
      encoding: 'utf8',
      env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1' },
    });
    const scoped = spawnSync(process.execPath, [CLI_ENTRY, 'workflow', 'run', '--help'], {
      encoding: 'utf8',
      env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1' },
    });
    expect(global.status).toBe(0);
    expect(scoped.status).toBe(0);
    expect(global.stdout).not.toBe(scoped.stdout);
    expect(global.stdout).toContain('--cwd <path>');
    expect(scoped.stdout).not.toContain('--cwd <path>');
    expect(scoped.stdout).toContain('--workflow-source');
    expect(scoped.stdout).toContain('--dry-run');
  });

  it('documents --workflow-source as a run-only flag in workflow run --help', () => {
    const scoped = spawnSync(process.execPath, [CLI_ENTRY, 'workflow', 'run', '--help'], {
      encoding: 'utf8',
      env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1' },
    });
    expect(scoped.status).toBe(0);
    expect(scoped.stdout).toContain('--workflow-source');
  });

  it('scopes workflow logs --help to --follow and excludes run-only flags', () => {
    // Proves the partition is not a one-off for workflow run: another
    // subcommand gets only its own flag, while a run-only flag drops out.
    const scoped = spawnSync(process.execPath, [CLI_ENTRY, 'workflow', 'logs', '--help'], {
      encoding: 'utf8',
      env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1' },
    });
    expect(scoped.status).toBe(0);
    expect(scoped.stdout).toContain('--follow');
    expect(scoped.stdout).not.toContain('--dry-run');
  });

  // Review R1 pin: every supported `workflow <subcommand> --help` slice
  // must render the matching Commands line and its Options block. These
  // six subcommands all exist in the dispatch but were left out of
  // `commandHelp`, so each `--help` invocation printed only a header. The
  // fix routes them through `scopedOnlyHelp` (kept separate so the global
  // Commands block stays byte-identical); the assertions below prove each
  // path now renders a Commands line plus its scoped flags, and that the
  // commands rendered for one subcommand do not leak into another's slice.
  for (const sub of ['approve', 'reject', 'cleanup', 'reset-sessions', 'event']) {
    it(`renders a non-empty Commands block and matching Options for workflow ${sub} --help`, () => {
      const scoped = spawnSync(process.execPath, [CLI_ENTRY, 'workflow', sub, '--help'], {
        encoding: 'utf8',
        env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1' },
      });
      expect(scoped.status).toBe(0);
      expect(scoped.stdout).toContain(`workflow ${sub}`);
      // Commands block must render content after the header (pre-fix:
      // each invocation printed only the nine-line header and exited 0).
      expect(scoped.stdout.split('\n').length).toBeGreaterThan(9);
    });
  }

  it('renders --detach and --comment in workflow approve --help without leaking other subcommands', () => {
    const scoped = spawnSync(process.execPath, [CLI_ENTRY, 'workflow', 'approve', '--help'], {
      encoding: 'utf8',
      env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1' },
    });
    expect(scoped.status).toBe(0);
    expect(scoped.stdout).toContain('--detach');
    expect(scoped.stdout).toContain('--comment');
    // --reason belongs to reject, not approve.
    expect(scoped.stdout).not.toContain('--reason');
    // --follow belongs to logs, not approve.
    expect(scoped.stdout).not.toContain('--follow');
  });

  it('renders --run-id/--type/--data in workflow event emit --help', () => {
    const scoped = spawnSync(process.execPath, [CLI_ENTRY, 'workflow', 'event', 'emit', '--help'], {
      encoding: 'utf8',
      env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1' },
    });
    expect(scoped.status).toBe(0);
    expect(scoped.stdout).toContain('--run-id <id>');
    expect(scoped.stdout).toContain('--type <event-type>');
    expect(scoped.stdout).toContain('--data <json>');
  });

  // Frozen pre-refactor template literal (557788e0d:packages/cli/src/cli.ts:140-260).
  // The byte-identical guarantee on global help is a load-bearing contract: shell
  // completions and downstream scripts pin the exact text. Embedding the frozen
  // string here means any future drift — a dropped Commands entry, a reordered
  // Options block, a column-width change in formatSpecLine — fails this test
  // instead of silently shipping.
  const PRE_REFACTOR_GLOBAL_HELP = `
Archon CLI - Run AI workflows from the command line

Usage:
  archon <command> [subcommand] [options] [arguments]

Commands:
  chat <message>             Send a message to the orchestrator
  setup                      Interactive setup wizard for credentials and config
  workflow list [name] [--full] [--json]
                             List compact workflow descriptions
                             Use <name> --full for one exact description
  workflow run <name> [msg]  Run a workflow with optional message
  workflow status            Show running/paused workflows for this project
  workflow runs              List recent runs (all statuses) for this project
  workflow get <run-id>      Show detail for a single run (any status)
  workflow logs <run-id>     Print or follow a run's JSONL transcript
  workflow wait <run-id>     Block until the run ends or needs a human decision
  workflow resume <run-id>   Resume a failed or paused run from completed nodes
  workflow cancel <run-id>   Stop a running workflow started with --detach
  workflow abandon <run-id>  Mark a run cancelled without stopping host work
  workflow respond <run-id> <decision> [text]
                             Resolve a paused gate with any of its declared decisions
                             ('approve'/'reject' are sugar for the dedicated commands)
  workflow search [query]    Search the workflow marketplace
  workflow install <slug>    Install a workflow from the marketplace
  workflow test [<name>|<folder>|<path>]
                             Run declared dry-run fixtures (fixtures/*.stubs.yaml) for a
                             workflow, a workflow folder or pack (by name or directory
                             path); relative paths resolve from the invoking directory before the
                             repository root. With no target, runs every fixture. Never creates a
                             run or contacts a provider; exec-code fixtures execute in a
                             scratch worktree of HEAD
  isolation list             List all active worktrees/environments
  isolation cleanup [days]   Remove stale environments (default: 7 days)
  isolation cleanup --merged Remove environments with branches merged into main
  complete <branch> [...]    Complete branch lifecycle (remove worktree + branches)
  serve                      Start the web UI server (downloads web UI on first run)
  skill install [path]       Install archon-cli into .claude/skills and .agents/skills
  doctor [--full]            Verify your Archon setup (Claude/Codex binaries, gh auth, DB, adapters; --full also probes the OpenCode runtime SDK)
  auth github                Connect your GitHub identity via device flow (multi-user installs)
  ai key set <provider>      Connect an AI provider API key (multi-user installs; key read from prompt/stdin)
  ai login <provider>        Connect a Claude, ChatGPT/Codex, or Copilot subscription
  ai list                    List your connected AI provider keys
  ai logout <provider>       Disconnect an AI provider key
  ai tier set <t> <p> <m>    Set a model tier (small/medium/large) → provider/model [--effort <e>] [--scope user|install]
  ai tier list [--json]      Show configured tiers (install + yours) vs built-in defaults
  ai tier unset <tier>       Unset a tier override (built-ins: claude/codex only) [--scope user|install]
  ai alias set <@n> <p> <m>  Set a @custom model alias [--effort <e>] [--scope user|install]
  ai alias list [--json]     Show configured @custom aliases (install + yours)
  ai alias unset <@name>     Remove a @custom alias [--scope user|install]
  ai default <p> [<model>]   Set the default assistant (+ chat model) [--scope user|install]
  telemetry status           Show anonymous telemetry state (enabled, reason, ID, host)
  telemetry reset            Rotate the anonymous install UUID
  validate workflows [name]  Validate workflow definitions and their references
  validate commands [name]   Validate command files
  version, --version, -V     Show version info (also -v when used alone)
  help                       Show this help message

Options:
  --cwd <path>               Override working directory (default: current directory)
  --branch, -b <name>        Create worktree for branch (or reuse existing)
  --from, --from-branch <name> Create new branch from specific start point
  --base <branch>            Per-dispatch base override for epic slices (worktree cut-from + PR target)
  --workflow-source <path>   Read the workflow, its commands and scripts from this directory
                             instead of --cwd (which stays the workspace the run acts on)
  --no-worktree              Run on branch directly without worktree isolation
  --folder                   Register the current non-git directory as a folder project and run in place
  --input <name>=<value>     Supply a declared workflow input; repeat per input (mutually exclusive with --resume)
  --model <name>=<spec>      Rebind small/medium/large or @alias for one run; repeat per binding
  --config <path>            Load a sparse YAML config layer for one fresh workflow run
  --resume                   Resume the most recent failed or paused run of the workflow (mutually exclusive with --branch)
  --adopt <run-id>           Start a new run adopting a terminal run's worktree/branch + artifacts ($ADOPTED_RUN_DIR)
  --supersedes <run-id>      Record this fresh run as replacing the prior run's open item (no lane inheritance)
  --dry-run                  Simulate workflow DAG control flow without creating a run or contacting a provider
  --stubs <path>             YAML node-output map for --dry-run
  --stubs-init <path>        Write a complete dry-run stub scaffold and exit
  --default-stubs            Fill missing reached nodes with validated placeholders during --dry-run
  --exec-code                Execute trusted bash/script nodes during --dry-run (default: require stubs)
  --pause-at-gates           Stop a dry-run at approval gates instead of auto-approving
  --spawn                    Open setup wizard in a new terminal window (for setup command)
  --quiet, -q                Reduce log verbosity to warnings and errors only
  --verbose, -v              Show debug-level output
  --json                     Output machine-readable JSON (list/status/get/wait/runs/approve/reject/respond/cancel/abandon/resume)
  --events                   For verbose JSON status/get: output raw event rows instead of node summaries
  --detach                   Run 'workflow run'/'approve'/'reject'/'respond'/'resume' in a detached background child (returns immediately)
  --all                      For 'workflow status/runs': list across all projects (ignore cwd scope)
  --status <status>          For 'workflow runs': filter to one status (running, completed, failed, ...)
  --open                     For 'workflow runs': the open-work inbox — failed runs nothing has adopted or superseded
  --limit <n>                For 'workflow runs': max rows (default 20)
  --timeout <seconds>        For 'workflow wait': give up after N seconds (default: wait indefinitely)
  --follow                   For 'workflow logs': stream appended rows until the run ends
  --conversation-id <id>     Reuse a stable conversation scope across runs (enables
                             persist_session resume between separate CLI invocations)
  --port <port>              Override server port for 'serve' (default: 3090)
  --download-only            Download web UI without starting the server
  --force                    Overwrite existing file (for workflow install)

Examples:
  archon chat "What does the orchestrator do?"
  archon workflow list
  archon workflow run investigate-issue "Fix the login bug"
  archon workflow run plan --cwd /path/to/repo "Add dark mode"
  archon workflow run implement --branch feature-auth "Implement auth"
  archon workflow run quick-fix --no-worktree "Fix typo"
  archon workflow run assist --folder "List every repo under this multi-repo root"
  archon workflow run archon-assist --detach "Investigate the flaky test"
  archon workflow run assist --dry-run --stubs ./stubs.yaml --json
  archon workflow runs --json
  archon workflow get <run-id> --json
  archon workflow logs <run-id> --follow
  archon workflow wait <run-id> --json
  archon workflow resume <run-id>
  archon workflow cancel <run-id>
  archon workflow runs --open
  archon workflow run archon-smart-pr-review --adopt <run-id> "Review the changes"
  archon skill install
  archon skill install /path/to/project
  archon workflow search "pr review"
  archon workflow install archon-piv-loop

`;

  it('archon --help matches the pre-refactor global index byte-for-byte', () => {
    const result = spawnSync(process.execPath, [CLI_ENTRY, '--help'], {
      encoding: 'utf8',
      env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(PRE_REFACTOR_GLOBAL_HELP);
  });

  it('archon help <cmd> [<subcmd>] matches archon <cmd> [<subcmd>] --help', () => {
    for (const argv of [
      ['workflow', 'run'],
      ['isolation', 'cleanup'],
      ['workflow', 'logs'],
    ]) {
      const viaHelp = spawnSync(process.execPath, [CLI_ENTRY, 'help', ...argv], {
        encoding: 'utf8',
        env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1' },
      });
      const viaFlag = spawnSync(process.execPath, [CLI_ENTRY, ...argv, '--help'], {
        encoding: 'utf8',
        env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1' },
      });
      expect(viaHelp.status).toBe(0);
      expect(viaFlag.status).toBe(0);
      expect(viaHelp.stdout).toBe(viaFlag.stdout);
    }
  });

  it('renders --merged and --include-closed in isolation cleanup --help', () => {
    const options = scopedHelpOptions(['isolation', 'cleanup']);
    expect(options).toContain('--merged');
    expect(options).toContain('--include-closed');
  });

  it('renders --reason in workflow reject --help', () => {
    expect(scopedHelpOptions(['workflow', 'reject'])).toContain('--reason');
  });

  it('renders --scope, --node, and --yes in workflow reset-sessions --help', () => {
    const options = scopedHelpOptions(['workflow', 'reset-sessions']);
    expect(options).toContain('--scope');
    expect(options).toContain('--node');
    expect(options).toContain('--yes');
  });

  it('renders --full in workflow list --help', () => {
    expect(scopedHelpOptions(['workflow', 'list'])).toContain('--full');
  });
});

describe('removed continue command', () => {
  // Full interpreter startup: the rejection lives in main()'s dispatch, not in
  // a pure guard, so a subprocess is the only way to pin the actual outcome.
  it('rejects archon continue and points to explicit run adoption', () => {
    const result = spawnSync(process.execPath, [CLI_ENTRY, 'continue', 'some/branch', 'carry on'], {
      encoding: 'utf8',
      env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Removed: 'archon continue'");
    expect(result.stderr).toContain('--adopt <run-id>');
  });

  it('rejects archon continue outside any git repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'archon-no-repo-'));
    try {
      const result = spawnSync(process.execPath, [CLI_ENTRY, 'continue', 'some/branch'], {
        encoding: 'utf8',
        cwd: dir,
        env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1' },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Removed: 'archon continue'");
      expect(result.stderr).toContain('--adopt <run-id>');
    } finally {
      await removeTempTree(dir);
    }
  });

  it('no longer parses the continue-only flags', () => {
    for (const flag of ['--workflow', '--no-context']) {
      expect(() =>
        parseArgs({
          args: ['workflow', 'run', 'x', flag, 'value'],
          options: cliArgOptions,
          allowPositionals: true,
          strict: true,
        })
      ).toThrow();
    }
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

  it('resolves a relative config path from the requested subdirectory cwd', async () => {
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
      await removeTempTree(repo);
    }
  });

  it('keeps a detached config handoff outside repo env overrides', async () => {
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
      await removeTempTree(repo);
    }
  });

  it('keeps a detached Docker install classified through target env loading', async () => {
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
      await removeTempTree(repo);
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
      'Usage: archon workflow status [--all] [--json] [--verbose] [--events]'
    );
    expect(result.stderr).toContain('archon workflow get <run-id>');
    expect(result.stdout).toBe('');
  });
});

describe('workflow status project scope', () => {
  it('uses the run-owned project after its conversation moves and returns every project with --all', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'archon-cli-status-scope-'));
    const archonHome = join(scratch, 'home');
    const projectA = join(scratch, 'project-a');
    const projectB = join(scratch, 'project-b');
    const unregisteredProject = join(scratch, 'unregistered-project');
    mkdirSync(archonHome, { recursive: true });
    mkdirSync(projectA);
    mkdirSync(projectB);
    mkdirSync(unregisteredProject);

    try {
      expect(spawnSync('git', ['init', '-q', '.'], { cwd: projectA }).status).toBe(0);
      expect(spawnSync('git', ['init', '-q', '.'], { cwd: projectB }).status).toBe(0);
      expect(spawnSync('git', ['init', '-q', '.'], { cwd: unregisteredProject }).status).toBe(0);
      const projectARoot = spawnSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: projectA,
        encoding: 'utf8',
      });
      const projectBRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: projectB,
        encoding: 'utf8',
      });
      expect(projectARoot.status).toBe(0);
      expect(projectBRoot.status).toBe(0);
      const env = {
        ...process.env,
        ARCHON_HOME: archonHome,
        ARCHON_TELEMETRY_DISABLED: '1',
        DATABASE_URL: '',
      };
      const initialize = spawnSync(
        process.execPath,
        [CLI_ENTRY, 'workflow', 'status', '--all', '--json', '--cwd', projectA],
        { cwd: projectA, env, encoding: 'utf8' }
      );
      expect({ status: initialize.status, stderr: initialize.stderr }).toEqual({
        status: 0,
        stderr: '',
      });

      const database = new Database(join(archonHome, 'archon.db'));
      try {
        const insertCodebase = database.prepare(
          'INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES (?, ?, ?)'
        );
        insertCodebase.run('codebase-a', 'fixture/a', projectARoot.stdout.trim());
        insertCodebase.run('codebase-b', 'fixture/b', projectBRoot.stdout.trim());

        const insertConversation = database.prepare(
          'INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id, codebase_id) VALUES (?, ?, ?, ?)'
        );
        insertConversation.run('conversation-a', 'cli', 'cli-a', 'codebase-a');
        insertConversation.run('conversation-b', 'cli', 'cli-b', 'codebase-b');

        const insertRun = database.prepare(
          'INSERT INTO remote_agent_workflow_runs (id, conversation_id, codebase_id, workflow_name, user_message, status) VALUES (?, ?, ?, ?, ?, ?)'
        );
        insertRun.run(
          '00000000-0000-4000-8000-00000000000a',
          'conversation-a',
          'codebase-a',
          'project-a-work',
          'test',
          'running'
        );
        insertRun.run(
          '00000000-0000-4000-8000-00000000000b',
          'conversation-b',
          'codebase-b',
          'project-b-work',
          'test',
          'paused'
        );
        database
          .prepare('UPDATE remote_agent_conversations SET codebase_id = ? WHERE id = ?')
          .run('codebase-b', 'conversation-a');
      } finally {
        database.close();
      }

      const scoped = spawnSync(
        process.execPath,
        [CLI_ENTRY, 'workflow', 'status', '--json', '--cwd', projectA],
        { cwd: projectA, env, encoding: 'utf8' }
      );
      expect({ status: scoped.status, stderr: scoped.stderr }).toEqual({ status: 0, stderr: '' });
      const scopedJson = JSON.parse(scoped.stdout) as {
        scopeFallback: boolean;
        runs: Array<{ workflow_name: string }>;
      };
      expect(scopedJson.scopeFallback).toBe(false);
      expect(scopedJson.runs.map(run => run.workflow_name)).toEqual(['project-a-work']);

      const otherProject = spawnSync(
        process.execPath,
        [CLI_ENTRY, 'workflow', 'status', '--json', '--cwd', projectB],
        { cwd: projectB, env, encoding: 'utf8' }
      );
      expect({ status: otherProject.status, stderr: otherProject.stderr }).toEqual({
        status: 0,
        stderr: '',
      });
      const otherProjectJson = JSON.parse(otherProject.stdout) as {
        scopeFallback: boolean;
        runs: Array<{ workflow_name: string }>;
      };
      expect(otherProjectJson.scopeFallback).toBe(false);
      expect(otherProjectJson.runs.map(run => run.workflow_name)).toEqual(['project-b-work']);

      const global = spawnSync(
        process.execPath,
        [CLI_ENTRY, 'workflow', 'status', '--all', '--json', '--cwd', projectA],
        { cwd: projectA, env, encoding: 'utf8' }
      );
      expect({ status: global.status, stderr: global.stderr }).toEqual({ status: 0, stderr: '' });
      const globalJson = JSON.parse(global.stdout) as {
        scopeFallback: boolean;
        runs: Array<{ workflow_name: string }>;
      };
      expect(globalJson.scopeFallback).toBe(false);
      expect(new Set(globalJson.runs.map(run => run.workflow_name))).toEqual(
        new Set(['project-a-work', 'project-b-work'])
      );

      const fallback = spawnSync(
        process.execPath,
        [CLI_ENTRY, 'workflow', 'status', '--json', '--cwd', unregisteredProject],
        { cwd: unregisteredProject, env, encoding: 'utf8' }
      );
      expect({ status: fallback.status, stderr: fallback.stderr }).toEqual({
        status: 0,
        stderr: '',
      });
      const fallbackJson = JSON.parse(fallback.stdout) as {
        scopeFallback: boolean;
        runs: Array<{ workflow_name: string }>;
      };
      expect(fallbackJson.scopeFallback).toBe(true);
      expect(new Set(fallbackJson.runs.map(run => run.workflow_name))).toEqual(
        new Set(['project-a-work', 'project-b-work'])
      );
    } finally {
      await removeTempTree(scratch);
    }
  }, 30_000);
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

describe('workflow logs arguments', () => {
  it.each([
    ['missing run id', ['workflow', 'logs']],
    ['extra positional', ['workflow', 'logs', 'abc123', 'accidental-extra']],
  ])('rejects %s', (_label, args) => {
    const result = spawnSync(process.execPath, [join(import.meta.dir, 'cli.ts'), ...args], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: archon workflow logs <run-id> [--follow]');
    expect(result.stdout).toBe('');
  });

  it('rejects --json because stdout is already raw JSONL', () => {
    const result = spawnSync(
      process.execPath,
      [join(import.meta.dir, 'cli.ts'), 'workflow', 'logs', 'abc123', '--json'],
      { encoding: 'utf8' }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('workflow logs already emits JSONL');
    expect(result.stdout).toBe('');
  });

  it('rejects the get-only --events mode', () => {
    const result = spawnSync(
      process.execPath,
      [join(import.meta.dir, 'cli.ts'), 'workflow', 'logs', 'abc123', '--events'],
      { encoding: 'utf8' }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--events applies to workflow status/get');
    expect(result.stdout).toBe('');
  });
});

describe('CLI workflow event dispatch', () => {
  it('resolves a run prefix using the registered effective cwd', async () => {
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
      await removeTempTree(scratch);
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

  describe('--follow flag', () => {
    it('parses workflow transcript follow mode', () => {
      const result = parseCliArgs(['workflow', 'logs', 'abc123', '--follow']);
      expect(result.values.follow).toBe(true);
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
//
// The helper owns an ARCHON_HOME because these spawns are real CLI processes:
// the no-git folder-project gate opens the Archon registry to decide whether an
// unregistered directory is a folder project, before it refuses the command.
// Inheriting the ambient home aimed that at the operator's ~/.archon, so the
// tests both mutated real state and queued behind whoever else held it. The
// registry sets `PRAGMA busy_timeout = 5000` — the same number as Bun's
// implicit per-test budget — so a contended open can spend the whole budget
// waiting: holding a write lock for 3 s made this command take 3.41 s, and an
// 8 s lock took it to the 5.54 s ceiling. A private registry removes the
// contention, and seeding it once below keeps schema creation out of every
// timed body (#2982).
let jsonEnvelopeHome: string;

function spawnJsonError(argv: string[], extraEnv: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...argv], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ARCHON_TELEMETRY_DISABLED: '1',
      ARCHON_HOME: jsonEnvelopeHome,
      ...extraEnv,
    },
  });
  return { status: result.status, envelope: () => JSON.parse(result.stdout ?? '') };
}

beforeAll(() => {
  jsonEnvelopeHome = mkdtempSync(join(tmpdir(), 'archon-json-envelope-home-'));

  // Build the registry once, here, so no timed body below pays for creating it.
  // Seeding through `spawnJsonError` rather than a bespoke spawn is deliberate:
  // it makes this also the check that the helper hands its ARCHON_HOME to the
  // child. If that wiring is ever dropped, no registry appears in the scratch
  // home and this throws, instead of every case below quietly falling back to
  // the operator's registry again.
  const seed = spawnJsonError(['workflow', 'list', '--json', '--cwd', tmpdir()]);
  if (!existsSync(join(jsonEnvelopeHome, 'archon.db'))) {
    throw new Error(
      `--json envelope tests could not seed a scratch registry in ${jsonEnvelopeHome}.\n` +
        `status=${String(seed.status)}\n${JSON.stringify(seed.envelope())}`
    );
  }
});

afterAll(async () => {
  if (jsonEnvelopeHome) await removeTempTree(jsonEnvelopeHome);
});

describe('workflow list arguments', () => {
  it('dispatches a named full-description request', () => {
    const { status, envelope } = spawnJsonError([
      'workflow',
      'list',
      'archon-fix-github-issue-codex',
      '--full',
      '--json',
      '--cwd',
      repoRoot,
    ]);

    expect(status).toBe(0);
    const output = envelope() as {
      workflows: Array<{
        name: string;
        description: string;
        descriptionTruncated: boolean;
      }>;
      errors: unknown[];
    };
    expect(output.workflows).toHaveLength(1);
    expect(output.workflows[0].name).toBe('archon-fix-github-issue-codex');
    expect(Array.from(output.workflows[0].description).length).toBeGreaterThan(160);
    expect(output.workflows[0].descriptionTruncated).toBe(false);
  });

  it('rejects extra positionals with human-readable usage', () => {
    const result = spawnSync(
      process.execPath,
      [CLI_ENTRY, 'workflow', 'list', 'first', 'second', '--cwd', repoRoot],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ARCHON_TELEMETRY_DISABLED: '1',
          ARCHON_HOME: jsonEnvelopeHome,
        },
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: archon workflow list [name] [--full] [--json]');
    expect(result.stdout).toBe('');
  });

  it('rejects extra positionals with one JSON error envelope', () => {
    const { status, envelope } = spawnJsonError([
      'workflow',
      'list',
      'first',
      'second',
      '--json',
      '--cwd',
      repoRoot,
    ]);

    expect(status).toBe(1);
    expect(envelope).not.toThrow();
    expect(envelope()).toEqual({
      ok: false,
      error: 'Usage: archon workflow list [name] [--full] [--json]',
    });
  });

  it('reports an unknown workflow through the JSON error envelope', () => {
    const { status, envelope } = spawnJsonError([
      'workflow',
      'list',
      'definitely-not-a-workflow',
      '--json',
      '--cwd',
      repoRoot,
    ]);

    expect(status).toBe(1);
    expect(envelope).not.toThrow();
    expect(envelope()).toMatchObject({
      ok: false,
      error: expect.stringContaining("Workflow 'definitely-not-a-workflow' not found"),
    });
  });

  it('preserves discovery errors in a missing-workflow JSON error envelope', async () => {
    const scratchRepo = mkdtempSync(join(tmpdir(), 'archon-workflow-list-errors-'));
    try {
      const gitInit = spawnSync('git', ['init', '--quiet', scratchRepo], { encoding: 'utf8' });
      expect(gitInit.status).toBe(0);
      const workflowDir = join(scratchRepo, '.archon', 'workflows');
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(join(workflowDir, 'broken.yaml'), 'name: broken\nnodes: [\n');

      const { status, envelope } = spawnJsonError([
        'workflow',
        'list',
        'definitely-not-a-workflow',
        '--json',
        '--cwd',
        scratchRepo,
      ]);

      expect(status).toBe(1);
      expect(envelope()).toMatchObject({
        ok: false,
        error: expect.stringContaining("Workflow 'definitely-not-a-workflow' not found"),
        errors: [
          {
            filename: 'broken.yaml',
            errorType: 'parse_error',
          },
        ],
      });
    } finally {
      await removeTempTree(scratchRepo);
    }
  });
});

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
    //
    // `--dry-run` is not part of the contract; it is how this test avoids
    // paying for one. A real run freezes the workflow source BEFORE resolving
    // the name (workflow.ts: prepareWorkflowSource precedes
    // resolveWorkflowName, deliberately — discovery must read the frozen
    // bytes, #2660/#2747), so without the flag this single spawn copies and
    // digests every project, global, and bundled workflow file this repository
    // has — thousands of filesystem operations, and growing — then deletes
    // them, only to report that the workflow does not exist. The throw, its
    // route to main()'s catch, and the envelope are identical either way.
    const { status, envelope } = spawnJsonError([
      'workflow',
      'run',
      'definitely-not-a-workflow',
      '--json',
      '--dry-run',
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

  it('leaves the default home untouched when the gate opens the registry', async () => {
    // Same command as the case above — the one route here that opens the
    // registry — but with the child's home directory pointed at a scratch tree,
    // so `<sentinel>/.archon` is what `getArchonHome()` would resolve to if the
    // helper's ARCHON_HOME stopped reaching the child. It must stay absent: the
    // registry belongs in the test-owned home, never the ambient one.
    const sentinel = mkdtempSync(join(tmpdir(), 'archon-json-envelope-sentinel-'));
    try {
      const { status } = spawnJsonError(['workflow', 'list', '--json', '--cwd', tmpdir()], {
        HOME: sentinel,
        USERPROFILE: sentinel,
      });

      expect(status).toBe(1);
      expect(existsSync(join(sentinel, '.archon'))).toBe(false);
      expect(existsSync(join(jsonEnvelopeHome, 'archon.db'))).toBe(true);
    } finally {
      await removeTempTree(sentinel);
    }
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

describe('workflow test path targets', () => {
  it('resolves a caller-relative path while discovering workflows from the repository root', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'archon-cli-workflow-test-cwd-'));
    const tools = join(repo, 'tools');
    const workflowDir = join(repo, '.archon', 'workflows', 'sdlc', 'plan');
    mkdirSync(join(workflowDir, 'fixtures'), { recursive: true });
    mkdirSync(tools, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8' });
    writeFileSync(
      join(workflowDir, 'plan.yaml'),
      'name: plan\ndescription: test\nnodes:\n  - id: node-a\n    prompt: hello\n'
    );
    writeFileSync(
      join(workflowDir, 'fixtures', 'ready.stubs.yaml'),
      'fixture:\n  expect: completed\nnode-a: stub output\n'
    );

    try {
      const result = spawnSync(
        process.execPath,
        [CLI_ENTRY, 'workflow', 'test', '../.archon/workflows/sdlc/plan', '--cwd', tools, '--json'],
        {
          encoding: 'utf8',
          timeout: 20000,
          env: {
            ...process.env,
            ARCHON_TELEMETRY_DISABLED: '1',
            ARCHON_HOME: join(repo, 'archon-home'),
          },
        }
      );

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        passed: 1,
        failed: 0,
        results: [{ fixture: 'sdlc/plan/fixtures/ready.stubs.yaml' }],
      });
    } finally {
      await removeTempTree(repo);
    }
  }, 30000);
});
