import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { renderHelp } from './help';

const CLI_ENTRY = join(import.meta.dir, 'cli.ts');

/**
 * The `Options:` block returned by the production help renderer.
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
  const output = renderHelp(argv[0], argv[1]);
  const marker = '\nOptions:\n';
  const start = output.indexOf(marker);
  expect(start, `no Options block in 'archon ${argv.join(' ')} --help'`).toBeGreaterThanOrEqual(0);
  const body = output.slice(start + marker.length);
  const end = body.indexOf('\n\n');
  return end === -1 ? body : body.slice(0, end);
}

describe('CLI help output', () => {
  const help = renderHelp();

  it('lists the workflow resume command', () => {
    expect(help).toContain(
      'workflow resume <run-id>   Resume a failed or paused run from completed nodes'
    );
  });

  it('lists the workflow transcript reader and follow flag', () => {
    expect(help).toContain("workflow logs <run-id>     Print or follow a run's JSONL transcript");
    expect(help).toContain('--follow');
  });

  it('documents project-scoped active status and its install-wide override', () => {
    expect(help).toContain(
      'workflow status            Show running/paused workflows for this project'
    );
    expect(help).toContain(
      "--all                      For 'workflow status/runs': list across all projects"
    );
  });

  it('documents compact and full workflow discovery', () => {
    expect(help).toContain('workflow list [name] [--full] [--json]');
    expect(help).toContain('List compact workflow descriptions');
    expect(help).toContain('Use <name> --full for one exact description');
  });

  it('distinguishes active cancel from state-only abandon', () => {
    expect(help).toContain(
      'workflow cancel <run-id>   Stop a running workflow started with --detach'
    );
    expect(help).toContain(
      'workflow abandon <run-id>  Mark a run cancelled without stopping host work'
    );
  });

  it('documents workflow dry-run flags', () => {
    expect(help).toContain('--dry-run');
    expect(help).toContain('--stubs <path>');
    expect(help).toContain('--stubs-init <path>');
    expect(help).toContain('--default-stubs');
    expect(help).toContain('--exec-code');
    expect(help).toContain('--pause-at-gates');
  });

  it('documents sparse repeatable model bindings', () => {
    expect(help).toContain('--model <name>=<spec>');
  });

  it('documents the per-run config file', () => {
    expect(help).toContain('--config <path>');
  });

  it('documents the unified skill destinations and subscription providers', () => {
    expect(help).toContain(
      'skill install [path]       Install archon-cli into .claude/skills and .agents/skills'
    );
    expect(help).toContain(
      'ai login <provider>        Connect a Claude, ChatGPT/Codex, or Copilot subscription'
    );
  });

  it('omits the removed branch-inferred continue command', () => {
    expect(help).not.toMatch(/\bcontinue <branch>/);
    expect(help).not.toContain('--workflow <name>');
    expect(help).not.toContain('--no-context');
  });

  it('documents exact run-id adoption as the continuation route', () => {
    expect(help).toContain(
      "--adopt <run-id>           Start a new run adopting a terminal run's worktree/branch + artifacts ($ADOPTED_RUN_DIR)"
    );
  });

  // The global anchor must disappear from a scoped slice, rather than
  // merely appending the same content under a different heading.
  it('produces scoped workflow run --help that differs from archon --help and scopes to run-only flags', () => {
    const global = renderHelp();
    const scoped = renderHelp('workflow', 'run');
    expect(global).not.toBe(scoped);
    expect(global).toContain('--cwd <path>');
    expect(scoped).not.toContain('--cwd <path>');
    expect(scoped).toContain('--workflow-source');
    expect(scoped).toContain('--dry-run');
  });

  it('documents --workflow-source as a run-only flag in workflow run --help', () => {
    const scoped = renderHelp('workflow', 'run');
    expect(scoped).toContain('--workflow-source');
  });

  it('scopes workflow logs --help to --follow and excludes run-only flags', () => {
    // Proves the partition is not a one-off for workflow run: another
    // subcommand gets only its own flag, while a run-only flag drops out.
    const scoped = renderHelp('workflow', 'logs');
    expect(scoped).toContain('--follow');
    expect(scoped).not.toContain('--dry-run');
  });

  // Scoped-only commands must retain their Commands lines even though they
  // do not appear in the global index.
  for (const sub of ['approve', 'reject', 'cleanup', 'reset-sessions', 'event']) {
    it(`renders a non-empty Commands block for workflow ${sub} --help`, () => {
      const scoped = renderHelp('workflow', sub);
      expect(scoped).toContain(`workflow ${sub}`);
      // Include the final newline that console.log adds to the rendered text.
      expect(`${scoped}\n`.split('\n').length).toBeGreaterThan(9);
    });
  }

  it('renders --detach and --comment in workflow approve --help without leaking other subcommands', () => {
    const scoped = renderHelp('workflow', 'approve');
    expect(scoped).toContain('--detach');
    expect(scoped).toContain('--comment');
    // --reason belongs to reject, not approve.
    expect(scoped).not.toContain('--reason');
    // --follow belongs to logs, not approve.
    expect(scoped).not.toContain('--follow');
  });

  it('renders --run-id/--type/--data in workflow event emit --help', () => {
    const scoped = renderHelp('workflow', 'event');
    expect(scoped).toContain('--run-id <id>');
    expect(scoped).toContain('--type <event-type>');
    expect(scoped).toContain('--data <json>');
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
  serve                      Start the web UI server (binary installs download it on first run)
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
    expect(`${renderHelp()}\n`).toBe(PRE_REFACTOR_GLOBAL_HELP);
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
      expect(viaFlag.stdout).toBe(`${renderHelp(argv[0], argv[1])}\n`);
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
