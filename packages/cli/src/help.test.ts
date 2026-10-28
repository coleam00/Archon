import { describe, it, expect } from 'bun:test';
import { RUN_PROJECT_CONFLICT_FLAGS } from './dispatch-guards';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { forgeRequestSchema } from '@archon/forge/operations';
import { formatSpecLine, helpEntries, renderHelp, renderHelpFor } from './help';
import { cliArgOptions } from './args';
import { attachmentCommands } from './attachment-commands';

const CLI_ENTRY = join(import.meta.dir, 'cli.ts');

/**
 * The `Options:` block that `archon <argv...> --help` prints.
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
  const output = renderHelpFor(argv);
  const marker = '\nOptions:\n';
  const start = output.indexOf(marker);
  expect(start, `no Options block in 'archon ${argv.join(' ')} --help'`).toBeGreaterThanOrEqual(0);
  const body = output.slice(start + marker.length);
  const end = body.indexOf('\n\n');
  return end === -1 ? body : body.slice(0, end);
}

it('renders every scopedFlags entry in its own scoped --help Options block', () => {
  const owners = helpEntries.filter(entry => entry.scopedFlags);
  expect(owners.length).toBeGreaterThan(0);
  for (const { command, subcommand, scopedFlags = [] } of owners) {
    const argv = [command, ...(subcommand?.split(' ') ?? [])];
    const options = scopedHelpOptions(argv);
    for (const flag of scopedFlags) {
      expect(options, `archon ${argv.join(' ')} --help`).toContain(
        formatSpecLine(flag.spec, flag.description)
      );
    }
  }
});

it('keeps run source and isolation flags consistent with the parser', () => {
  const options = scopedHelpOptions(['workflow', 'run']).split('\n');
  for (const name of ['project', 'workflow-source', 'no-worktree', 'folder', 'container']) {
    const parserOption = cliArgOptions[name];
    expect(parserOption).toBeDefined();
    const lines = options.filter(line => line.trimStart().startsWith(`--${name} `));
    expect(lines).toHaveLength(1);
    const spec = lines[0]?.trimStart().split(/ {2,}/)[0];
    if (parserOption?.type === 'string') {
      expect(spec).toMatch(new RegExp(`^--${name} <[^>]+>$`));
    } else {
      expect(spec).toBe(`--${name}`);
    }
  }
});

describe('CLI help output', () => {
  const help = renderHelp();

  it('lists session reset and event emission globally and in workflow help', () => {
    for (const output of [help, renderHelp('workflow')]) {
      expect(output).toContain('workflow reset-sessions <workflow-name>');
      expect(output).toContain('workflow event emit');
    }
  });

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

  it('describes cancel and abandon', () => {
    expect(help).toContain(
      'workflow cancel <run-id>   Stop a running workflow (stops an owning process first)'
    );
    expect(help).toContain(
      'workflow abandon <run-id>  Mark a run cancelled, stopping a live owner first'
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
      'skill add [path]           Add archon-cli into .claude/skills and .agents/skills'
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

  it('documents --container in workflow run options', () => {
    expect(scopedHelpOptions(['workflow', 'run'])).toContain('--container');
    expect(scopedHelpOptions(['workflow', 'answer'])).not.toContain('--container');
  });

  it('scopes workflow logs --help to its own flags and excludes run-only flags', () => {
    // Proves the partition is not a one-off for workflow run: another
    // subcommand gets only its own flags, while a run-only flag drops out.
    const scoped = renderHelp('workflow', 'logs');
    expect(scoped).toContain('--follow');
    expect(scoped).toContain('--format <jsonl|text>');
    expect(scoped).not.toContain('--dry-run');
  });

  for (const sub of ['approve', 'reject', 'cleanup', 'reset-sessions', 'event']) {
    it(`renders a non-empty Commands block for workflow ${sub} --help`, () => {
      const scoped = renderHelp('workflow', sub);
      expect(scoped).toContain(`workflow ${sub}`);
      // Include the final newline that console.log adds to the rendered text.
      expect(`${scoped}\n`.split('\n').length).toBeGreaterThan(9);
    });
  }

  it('renders --detach in workflow approve --help without leaking other subcommands', () => {
    const scoped = renderHelp('workflow', 'approve');
    expect(scoped).toContain('--detach');
    // --reason belongs to reject, not approve.
    expect(scoped).not.toContain('--reason');
    // --follow belongs to logs, not approve.
    expect(scoped).not.toContain('--follow');
  });

  for (const request of forgeRequestSchema.options) {
    const op = request.shape.op.value;
    it(`renders scoped help for the admitted forge operation ${op}`, () => {
      expect(renderHelp('forge', op)).toContain(`forge ${op}`);
      expect(scopedHelpOptions(['forge', op])).toContain('--data <json>');
    });
  }

  const EXPECTED_GLOBAL_HELP = `
Archon CLI - Run AI workflows from the command line

Usage:
  archon <command> [subcommand] [options] [arguments]

Commands:
  state <get|put|patch|log|delete|list>
                             Read and audit durable project or install JSON documents
  forge resolve              Resolve an explicit remote through optional forge plugins
  forge checks               Observe checks for an explicit qualified pull request
  user <list|role|link>      List users, link identities and manage roles as the operator
  project list               List registered projects (id, kind, name, key, path)
  trigger <fire|drain|list|inspect|withdraw|recover-preparation|schedule>
                             Start configured workflows and inspect durable resource admission
  chat <message>             Send a message to the orchestrator
  setup [--scope <home|project>] Interactive setup wizard for credentials and config
  workflow list [name] [--full] [--json]
                             List compact workflow descriptions
                             Use <name> --full for one exact description
  workflow run <name> [msg]  Run a workflow with optional message
  workflow status            Show running/paused workflows for this project
  workflow runs              List recent runs (all statuses) for this project
  workflow get <run-id>      Show detail for a single run (any status)
  workflow artifacts <run-id> [path] List a run's artifact files, or print one
  workflow logs <run-id>     Print or follow a run's JSONL transcript
  workflow wait <run-id>     Block until the run ends or needs attention
  workflow attention [<run-id>] List, count or stream the attention queue, or read the item one run stands for
                             (defaults to the current project)
  workflow attention label <run-id> --occurrence <id>
                             Set or remove labels on the attention wait a run is paused at
  workflow resume <run-id>   Resume a failed or paused run from completed nodes
  workflow wake [--watch] [--json] Wake due continuations across this install
  workflow signal <full-run-id> Signal and wake an event wait; use --occurrence for an exact match
  workflow cancel <run-id>   Stop a running workflow (stops an owning process first)
  workflow abandon <run-id>  Mark a run cancelled, stopping a live owner first
  workflow end-turn <run-id> Record a request to end stalled tools or reported work
  workflow respond <run-id> <decision> [text]
                             Resolve a paused gate with any of its declared decisions
                             ('approve'/'reject' are sugar for the dedicated commands)
  workflow answer <run-id> --occurrence <id>
                             Answer a paused attention wait in its declared form
  workflow reset-sessions <workflow-name>
                             Delete persisted sessions for a workflow (omits --scope only with --yes; [--node <id>] [--json])
  workflow event emit        Emit a workflow event into a run
  workflow test [<name>|<folder>|<path>]
                             Run declared dry-run fixtures (fixtures/*.stubs.yaml) for a
                             workflow, a workflow folder or pack (by name or directory
                             path); relative paths resolve from the invoking directory before the
                             repository root. With no target, runs every fixture. Never creates a
                             run or contacts a provider; exec-code fixtures execute in a
                             scratch worktree of HEAD
  isolation list             List all active worktrees/environments
  isolation cleanup [days]   Remove stale environments (default: 7 days)
  isolation cleanup --merged Remove environments with branches merged into the base branch
  complete <branch> [...]    Remove worktree and local branch; retain remote branch
  serve                      Start the web UI server (binary installs download server and UI on first run)
  skill add [path]           Add archon-cli into .claude/skills and .agents/skills
  provider add <id...>       Add maintained providers matching this Archon release (connects your agent CLI or SDK)
  plugin add <owner/repo[/path][@tag]>
                             Add a plugin from GitHub (default: binary plugins the latest release, workflow packs the default branch)
  plugin update <id>[@tag]   Reinstall an installed plugin at a tag, or its latest release or default branch
  plugin remove <id>         Delete the files an installed plugin wrote
  plugin copy <id>           Copy an installed workflow pack into this project's .archon/workflows/
  plugin list                Show installed plugins with tag and commit
  doctor                     Verify installed provider diagnostics, DB, and adapters
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
  ai capacity [--json]       Show provider attempts holding concurrency.providers capacity
  ai capacity release <id>   Release a held attempt whose owner process you verified is gone
  ai default <p> [<model>]   Set the default assistant (+ chat model) [--scope user|install]
  telemetry status           Show anonymous telemetry state (enabled, reason, ID, host)
  telemetry reset            Rotate the anonymous install UUID
  telemetry no-match         Record an agent decision that no workflow fits
  validate workflows [name]  Validate workflow definitions and their references
  validate commands [name]   Validate command files
  version, --version, -V     Show version info (also -v when used alone)
  help                       Show this help message

Options:
  --chat-project-id <id>     Confine chat workflow commands to a registered project ID
  --cwd <path>               Override working directory (default: current directory)
  --project <id|name>        Bind to a registered repository (see project list). Source/config come from --cwd;
                             isolated execution uses the registered checkout. Use --no-worktree to execute in --cwd.
                             Cannot combine with ${RUN_PROJECT_CONFLICT_FLAGS.map(flag => `--${flag}`).join(', ')}.
  --branch, -b <name>        Create worktree for branch (or reuse existing)
  --from, --from-branch <name> Create new branch from specific start point
  --base-branch <name>       Initial repository registration only; omit to follow the remote default. Use --base for a run override.
  --base <branch>            Per-dispatch base override for epic slices (worktree cut-from + PR target)
  --workflow-source <path>   Read the workflow, its commands and scripts from this directory
                             instead of --cwd (which stays the workspace the run acts on)
  --no-worktree              Run on branch directly without worktree isolation
  --folder                   Register the current directory (with or without git) as a folder project and run in place
  --container                Run a folder project in container isolation
  --input <name>=<value>     Supply a declared workflow input; repeat per input (mutually exclusive with --resume)
  --model <name>=<spec>      Rebind small/medium/large or @alias for one run; repeat per binding
  --config <path>            Load a sparse YAML config layer for one fresh workflow run
  --config-from-run <run-id> Start a fresh run with the run config another run was started with
  --resume                   Resume the most recent failed or paused run of the workflow (mutually exclusive with --branch)
  --adopt <run-id>           Start a new run adopting a terminal run's worktree/branch + artifacts ($ADOPTED_RUN_DIR)
  --supersedes <run-id>      Record this fresh run as replacing the prior run's open item (no lane inheritance)
  --dry-run                  Simulate workflow DAG control flow without creating a run or contacting a provider
  --stubs <path>             YAML node-output map for --dry-run
  --stubs-init <path>        Write a complete dry-run stub scaffold and exit
  --default-stubs            Fill missing reached nodes with validated placeholders during --dry-run
  --exec-code                Execute trusted bash/script nodes during --dry-run (default: require stubs)
  --pause-at-gates           Stop a dry-run at approval gates instead of auto-approving
  --providers <ids>          Add comma-separated maintained providers, skipping the setup provider question
  --spawn                    Open setup wizard in a new terminal window (for setup command)
  --quiet, -q                Log warnings and errors only (the default except for serve)
  --verbose, -v              Show debug-level logs (on stderr; on stdout for serve)
  --json                     Output machine-readable JSON (list/status/get/artifacts/wait/attention/runs/approve/reject/respond/answer/cancel/abandon/resume, project list)
  --events                   For verbose JSON status/get: output raw event rows instead of node summaries
  --occurrence <id>          For 'workflow approve/reject/respond/answer/attention label': refuse the write unless the run is still
                             paused at this occurrence (the 'occurrence' that 'workflow wait --json' reports; required by answer
                             and attention label)
  --detach                   Run 'workflow run'/'approve'/'reject'/'respond'/'resume' in a detached background child (resume returns after acceptance, before completion)
  --all                      For 'workflow status/runs': list across all projects (ignore cwd scope)
  --status <status>          For 'workflow runs': filter to one status (running, completed, failed, ...)
  --open                     For 'workflow runs': the open-work inbox — failed runs nothing has adopted or superseded
  --limit <n>                For 'workflow runs': max rows (default 20)
  --timeout <seconds>        For 'workflow wait': give up after N seconds (default: wait indefinitely)
  --follow                   For 'workflow logs': stream appended rows until the run ends
  --format <jsonl|text>      For 'workflow logs': jsonl (default) prints the exact transcript;
                             text renders it as progress lines for a human
  --conversation-id <id>     Correlation id for the run's messages. It creates no
                             conversation and no persist_session scope
  --port <port>              Override server port for 'serve' (default: 3090)
  --download-only            Download server and web UI without starting the server
  --force                    For 'setup': overwrite existing values instead of merging
                             For 'complete': remove even when safety checks block it

Examples:
  archon chat "What does the orchestrator do?"
  archon workflow list
  archon workflow run investigate-issue "Fix the login bug"
  archon workflow run plan --cwd /path/to/repo "Add dark mode"
  archon workflow run implement --branch feature-auth "Implement auth"
  archon workflow run quick-fix --no-worktree "Fix typo"
  archon workflow run investigate --folder "Explain how the repos under this root fit together"
  archon workflow run archon-investigate --detach "Investigate the flaky test"
  archon workflow run investigate --dry-run --stubs ./stubs.yaml --json
  archon workflow runs --json
  archon workflow get <run-id> --json
  archon workflow artifacts <run-id> plan.md
  archon project list --json
  archon workflow logs <run-id> --follow
  archon workflow logs <run-id> --follow --format text
  archon workflow wait <run-id> --json
  archon workflow resume <run-id>
  archon workflow cancel <run-id>
  archon workflow runs --open
  archon workflow run archon-review --adopt <run-id> "Review the changes"
  archon skill add
  archon skill add /path/to/project
  archon plugin add coleam00/Archon/plugins/forge-github

`;

  it('archon --help matches the supported global index byte-for-byte', () => {
    expect(`${renderHelp()}\n`).toBe(EXPECTED_GLOBAL_HELP);
  });

  it.each([
    ['plugin', '<owner/repo[/path][@tag]>'],
    ['skill', '[path]'],
  ])('retains scoped help for the %s alias without advertising it globally', (command, args) => {
    const result = spawnSync(process.execPath, [CLI_ENTRY, command, 'install', '--help'], {
      encoding: 'utf8',
      env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${command} install ${args}`);
    expect(result.stdout).toContain(`Deprecated alias for archon ${command} add`);
    expect(renderHelp()).not.toContain(`${command} install`);
  });

  it('archon help <cmd> [<subcmd>] matches archon <cmd> [<subcmd>] --help', () => {
    for (const argv of [
      ['workflow', 'run'],
      ['isolation', 'cleanup'],
      ['workflow', 'logs'],
      ['workflow', 'attention', 'label'],
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
      expect(viaFlag.stdout).toBe(`${renderHelpFor(argv)}\n`);
    }
  });

  it('does not promise a prompt in workflow reset-sessions --help', () => {
    expect(scopedHelpOptions(['workflow', 'reset-sessions'])).not.toContain('prompt');
  });
});

it('workflow run help distinguishes initial registration from the dispatch override', () => {
  const text = scopedHelpOptions(['workflow', 'run']);
  expect(text).toContain('--base-branch <name>');
  expect(text).toContain('Initial repository registration only');
  expect(text).toContain('--base <branch>');
});

it('provider and plugin add help exposes the supported commands and plugin example', () => {
  expect(renderHelp('provider', 'add')).toContain('provider add <id...>');
  const plugin = renderHelp('plugin', 'add');
  expect(plugin).toContain('plugin add <owner/repo[/path][@tag]>');
  expect(plugin).toContain('archon plugin add coleam00/Archon/plugins/forge-github');
});

it('every supported attachment verb has scoped help, with aliases scoped only', () => {
  const global = renderHelp();
  for (const [command, verbs] of Object.entries(attachmentCommands)) {
    for (const [verb, entry] of Object.entries(verbs)) {
      const spec = `${command} ${verb} ${entry.args}`.trimEnd();
      expect(renderHelp(command, verb)).toContain(spec);
      if ('scopedOnly' in entry) {
        expect(global).not.toContain(spec);
      } else {
        expect(global).toContain(spec);
      }
    }
  }
});

it('documents host metadata separately from plugin operations', () => {
  const scoped = renderHelp('forge', 'metadata');
  expect(scoped).toContain('without credentials or forge operations');
  expect(scoped).toContain('"host":"github.com"');
  expect(renderHelp()).not.toContain('forge metadata');
});
