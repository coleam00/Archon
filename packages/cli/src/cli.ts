#!/usr/bin/env bun
/**
 * Archon CLI - Run AI workflows from the command line
 *
 * Usage:
 *   archon workflow list              List available workflows
 *   archon workflow run <name> [msg]  Run a workflow
 *   archon version                    Show version info
 */
// Must be the very first import — strips Bun-auto-loaded CWD .env keys before
// any module reads process.env at init time (e.g. @archon/paths/logger reads LOG_LEVEL).
import '@archon/paths/strip-cwd-env-boot';
// Then load archon-owned env from ~/.archon/.env (user scope) and
// <cwd>/.archon/.env (repo scope, wins over user). Both with override: true.
// See packages/paths/src/env-loader.ts and the three-path model (#1302 / #1303).
import { loadArchonEnv } from '@archon/paths/env-loader';
loadArchonEnv(process.cwd());

// Install the pipe-safe `console.log` shim BEFORE any command module imports.
// `console.log` reaches fd 1 via a non-blocking pipe (pino opens it that way at
// module load via `@archon/paths/strip-cwd-env-boot` above), and short writes
// are silently dropped against a slow reader. The shim delegates through
// `writeStdout` so the stream layer queues short writes and retries `EAGAIN`
// instead of dropping the tail — but delivery is fire-and-forget, so the
// patched `console.log` returns synchronously and the exit path below must
// await `flushPendingWrites()` before `process.exit()`. See
// `utils/exit-with-drain.ts` (the call site that owns the drain) and
// `utils/safe-console.ts` for the underlying shim, and #2400 for the full
// rationale.
import { installPipeSafeConsole } from './utils/safe-console';
import { withDrainedExit } from './utils/exit-with-drain';
installPipeSafeConsole();

import { parseArgs } from 'util';
import { cliArgOptions } from './args';
import { resolve } from 'path';
import { existsSync, realpathSync } from 'fs';
import { stat } from 'fs/promises';

// Smart defaults for Claude auth
// If no explicit tokens, default to global auth from `claude /login`
if (!process.env.CLAUDE_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  if (process.env.CLAUDE_USE_GLOBAL_AUTH === undefined) {
    process.env.CLAUDE_USE_GLOBAL_AUTH = 'true';
  }
}

// DATABASE_URL is no longer required - SQLite will be used as default

// Bootstrap provider registry before any provider lookups
import { registerBuiltinProviders, registerCommunityProviders } from '@archon/providers';
registerBuiltinProviders();
registerCommunityProviders();

// Import commands after dotenv is loaded
import { versionCommand } from './commands/version';
import {
  workflowListCommand,
  workflowRunCommand,
  workflowStatusCommand,
  workflowGetCommand,
  workflowRunsCommand,
  workflowResumeCommand,
  workflowCancelCommand,
  workflowAbandonCommand,
  workflowApproveCommand,
  workflowRejectCommand,
  workflowRespondCommand,
  workflowCleanupCommand,
  workflowResetSessionsCommand,
  workflowEventEmitCommand,
  workflowSearchCommand,
  workflowTestCommand,
  workflowInstallCommand,
  isValidEventType,
} from './commands/workflow';
import { WORKFLOW_EVENT_TYPES } from '@archon/workflows/store';
import {
  isolationListCommand,
  isolationCleanupCommand,
  isolationCleanupMergedCommand,
  isolationCompleteCommand,
} from './commands/isolation';
import { continueCommand } from './commands/continue';
import { chatCommand } from './commands/chat';
import { setupCommand } from './commands/setup';
import { skillInstallCommand } from './commands/skill';
import { validateWorkflowsCommand, validateCommandsCommand } from './commands/validate';
import { serveCommand } from './commands/serve';
import { doctorCommand } from './commands/doctor';
import { authGithubCommand } from './commands/auth';
import {
  aiKeySetCommand,
  aiListCommand,
  aiLogoutCommand,
  aiLoginCommand,
  aiTierSetCommand,
  aiTierListCommand,
  aiTierUnsetCommand,
  aiAliasSetCommand,
  aiAliasListCommand,
  aiAliasUnsetCommand,
  aiDefaultCommand,
} from './commands/ai';
import { telemetryStatusCommand, telemetryResetCommand } from './commands/telemetry';
import { closeDatabase } from '@archon/core';
import {
  setLogLevel,
  createLogger,
  checkForUpdate,
  BUNDLED_IS_BINARY,
  BUNDLED_VERSION,
  shutdownTelemetry,
  captureArchonStarted,
  isVerboseBoot,
} from '@archon/paths';
import * as git from '@archon/git';

/** True when `path` exists and is a directory (used to validate `--workflow-source`). */
async function isPathDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli');
  return cachedLog;
}

/**
 * Print usage information
 */
function printUsage(): void {
  console.log(`
Archon CLI - Run AI workflows from the command line

Usage:
  archon <command> [subcommand] [options] [arguments]

Commands:
  chat <message>             Send a message to the orchestrator
  setup                      Interactive setup wizard for credentials and config
  workflow list              List available workflows in current directory
  workflow run <name> [msg]  Run a workflow with optional message
  workflow status            Show status of running/paused workflows
  workflow runs              List recent runs (all statuses) for this project
  workflow get <run-id>      Show detail for a single run (any status)
  workflow resume <run-id>   Resume a failed or paused run from completed nodes
  workflow cancel <run-id>   Stop a running workflow started with --detach
  workflow abandon <run-id>  Mark a run cancelled without stopping host work
  workflow respond <run-id> <decision> [text]
                             Resolve a paused gate with any of its declared decisions
                             ('approve'/'reject' are sugar for the dedicated commands)
  workflow search [query]    Search the workflow marketplace
  workflow install <slug>    Install a workflow from the marketplace
  workflow test [<name>|<pack>]
                             Run declared dry-run fixtures (fixtures/*.stubs.yaml) for a
                             workflow or pack; never creates a run or contacts a provider
  isolation list             List all active worktrees/environments
  isolation cleanup [days]   Remove stale environments (default: 7 days)
  isolation cleanup --merged Remove environments with branches merged into main
  continue <branch> [msg]    Continue work on an existing worktree with prior context
  complete <branch> [...]    Complete branch lifecycle (remove worktree + branches)
  serve                      Start the web UI server (downloads web UI on first run)
  skill install [path]       Install the bundled Archon skill into .claude/skills/archon
  doctor [--full]            Verify your Archon setup (Claude/Codex binaries, gh auth, DB, adapters; --full also probes the OpenCode runtime SDK)
  auth github                Connect your GitHub identity via device flow (multi-user installs)
  ai key set <provider>      Connect an AI provider API key (multi-user installs; key read from prompt/stdin)
  ai login <provider>        Connect a subscription (claude/copilot) via OAuth — codex is API-key only
  ai list                    List your connected AI provider keys
  ai logout <provider>       Disconnect an AI provider key
  ai tier set <t> <p> <m>    Set a model tier (small/medium/large) → provider/model [--effort <e>] [--scope user|install]
  ai tier list [--json]      Show configured tiers (install + yours) vs built-in defaults
  ai tier unset <tier>       Reset a tier to its built-in default [--scope user|install]
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
  --resume                   Resume the most recent failed or paused run of the workflow (mutually exclusive with --branch)
  --dry-run                  Simulate workflow DAG control flow without creating a run or contacting a provider
  --stubs <path>             YAML node-output map for --dry-run
  --stubs-init <path>        Write a complete dry-run stub scaffold and exit
  --default-stubs            Fill missing reached nodes with validated placeholders during --dry-run
  --exec-code                Execute trusted bash/script nodes during --dry-run (default: require stubs)
  --pause-at-gates           Stop a dry-run at approval gates instead of auto-approving
  --spawn                    Open setup wizard in a new terminal window (for setup command)
  --quiet, -q                Reduce log verbosity to warnings and errors only
  --verbose, -v              Show debug-level output
  --json                     Output machine-readable JSON (list/status/get/runs/approve/reject/respond/cancel/abandon/resume)
  --events                   For verbose JSON status/get: output raw event rows instead of node summaries
  --detach                   Run 'workflow run'/'approve'/'reject'/'respond'/'resume' in a detached background child (returns immediately)
  --all                      For 'workflow runs': list across all projects (ignore cwd scope)
  --status <status>          For 'workflow runs': filter to one status (running, completed, failed, ...)
  --limit <n>                For 'workflow runs': max rows (default 20)
  --workflow <name>          Workflow to run for 'continue' (default: archon-assist)
  --no-context               Skip context injection for 'continue'
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
  archon workflow resume <run-id>
  archon workflow cancel <run-id>
  archon continue fix/issue-42 --workflow archon-smart-pr-review "Review the changes"
  archon skill install
  archon skill install /path/to/project
  archon workflow search "pr review"
  archon workflow install archon-piv-loop
`);
}

/**
 * Safely close the database connection
 */
async function closeDb(): Promise<void> {
  try {
    await closeDatabase();
  } catch (error) {
    const err = error as Error;
    // Log with details but don't throw - we want the original error to be visible
    getLog().warn({ err }, 'db_close_failed');
  }
}

async function printUpdateNotice(quiet: boolean | undefined): Promise<void> {
  if (quiet || !BUNDLED_IS_BINARY) return;
  try {
    const result = await checkForUpdate(BUNDLED_VERSION);
    if (result?.updateAvailable) {
      process.stderr.write(
        `Update available: v${result.currentVersion} → v${result.latestVersion} — ${result.releaseUrl}\n`
      );
    }
  } catch (err) {
    getLog().debug({ err }, 'update_check.notice_failed');
  }
}

/**
 * Main CLI entry point
 * Returns exit code (0 = success, non-zero = failure)
 */
/**
 * Detect a request for version output. Treats `--version`, `-V`, and the
 * single-dash typo `-version` as version flags anywhere in argv. `-v` keeps
 * its role as the short alias for `--verbose`, except when used alone — then
 * it falls back to version output to match the convention used by node, npm,
 * bun, and most other CLIs.
 */
function isVersionRequest(args: string[]): boolean {
  if (args.length === 1 && args[0] === '-v') return true;
  return args.some(arg => arg === '--version' || arg === '-V' || arg === '-version');
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);

  // Anonymous once-per-invocation startup event (self-gates on opt-out).
  // Emitted before any early return so EVERY invocation — including bare
  // `archon`, `--help`, and `--version` — is counted, matching the
  // "once per CLI invocation" contract. Each early-return path below flushes
  // via shutdownTelemetry(); the main command path flushes in its finally.
  captureArchonStarted({ surface: 'cli' });

  // Handle no arguments - show help and exit successfully
  if (args.length === 0) {
    printUsage();
    await shutdownTelemetry();
    return 0;
  }

  // Version flag aliases bypass option parsing and the git-repo check so
  // `archon --version` works the same as `archon version` from any directory.
  if (isVersionRequest(args)) {
    try {
      await versionCommand();
      return 0;
    } finally {
      await shutdownTelemetry();
      await closeDb();
    }
  }

  // Parse global options
  let parsedArgs: { values: Record<string, unknown>; positionals: string[] };

  try {
    parsedArgs = parseArgs({
      args,
      options: cliArgOptions,
      allowPositionals: true,
      // Strict mode rejects unknown flags so a mistyped option (e.g. `--dry-run`)
      // errors here instead of being silently dropped before command validation.
      strict: true,
    });
  } catch (error) {
    const err = error as Error;
    console.error(`Error parsing arguments: ${err.message}`);
    printUsage();
    await shutdownTelemetry();
    return 1;
  }

  const { values, positionals } = parsedArgs;
  const cwdValue = values.cwd;
  const cwd = resolve(typeof cwdValue === 'string' ? cwdValue : process.cwd());
  const branchName = values.branch as string | undefined;
  const fromBranch =
    (values.from as string | undefined) ?? (values['from-branch'] as string | undefined);
  const baseBranch = values.base as string | undefined;
  const workflowSourceFlag = values['workflow-source'] as string | undefined;
  const noWorktree = values['no-worktree'] as boolean | undefined;
  const folderFlag = values.folder as boolean | undefined;
  const containerFlag = values.container as boolean | undefined;
  const resumeFlag = values.resume as boolean | undefined;
  const spawnFlag = values.spawn as boolean | undefined;
  const jsonFlag = values.json as boolean | undefined;
  const detachFlag = values.detach as boolean | undefined;
  const dryRunFlag = values['dry-run'] as boolean | undefined;
  const stubsPath = values.stubs as string | undefined;
  const stubsInitPath = values['stubs-init'] as string | undefined;
  const defaultStubsFlag = values['default-stubs'] as boolean | undefined;
  const execCodeFlag = values['exec-code'] as boolean | undefined;
  const pauseAtGatesFlag = values['pause-at-gates'] as boolean | undefined;
  // Handle help flag
  if (values.help) {
    printUsage();
    await shutdownTelemetry();
    return 0;
  }

  // Get command and subcommand
  const command = positionals[0];
  const subcommand = positionals[1];

  // Commands that don't require git repo validation
  const noGitCommands = [
    'version',
    'help',
    'setup',
    'chat',
    'continue',
    'serve',
    'skill',
    'doctor',
    'telemetry',
    'auth',
    'ai',
  ];
  const requiresGitRepo = !noGitCommands.includes(command ?? '');

  try {
    // setup/doctor/telemetry default to warn to avoid Pino info JSON interleaving with their human-readable output; lazy loggers pick up this level at first creation
    const isInteractiveCommand =
      command === 'setup' || command === 'doctor' || command === 'telemetry';
    const suppressByDefault = isInteractiveCommand && !values.verbose && !isVerboseBoot();
    // --json must keep stdout to EXACTLY the machine-readable payload. Pino's
    // default destination is stdout, so even one warn/error line would precede
    // the JSON and break JSON.parse for a consuming agent. Silence logs entirely
    // (not just lower to 'warn' — warnings still print at that level): every
    // --json command surfaces failures inside its own { ok: false } envelope, so
    // no diagnostic the caller needs is lost.
    if (jsonFlag) {
      setLogLevel('silent');
    } else if (values.quiet || suppressByDefault) {
      setLogLevel('warn');
    } else if (values.verbose) {
      setLogLevel('debug');
    }

    // Note: orphaned run cleanup moved to `workflow cleanup` command only.
    // Running it on every CLI startup killed parallel workflow runs (all
    // 'running' status rows were marked failed by each new process).

    // Marketplace search doesn't need a git repo — handle before git validation
    if (command === 'workflow' && subcommand === 'search') {
      const query = positionals[2];
      try {
        await workflowSearchCommand(query, jsonFlag);
      } catch (error) {
        const err = error as Error;
        console.error(`Error: ${err.message}`);
        return 1;
      }
      return 0;
    }

    // Fixture testing reads workflow files only — handle before git validation,
    // like marketplace search above.
    if (command === 'workflow' && subcommand === 'test') {
      const target = positionals[2];
      try {
        // Resolve to the repo root like the git gate below does, so project
        // workflow discovery reads the repository, not a subdirectory of it.
        const testCwd = requiresGitRepo ? ((await git.findRepoRoot(cwd)) ?? cwd) : cwd;
        return await workflowTestCommand(testCwd, target, { json: jsonFlag });
      } catch (error) {
        const err = error as Error;
        console.error(`Error: ${err.message}`);
        return 1;
      }
    }

    // Validate working directory exists
    let effectiveCwd = cwd;
    if (requiresGitRepo) {
      if (!existsSync(cwd)) {
        console.error(`Error: Directory does not exist: ${cwd}`);
        return 1;
      }

      // Validate git repository and resolve to root
      const repoRoot = await git.findRepoRoot(cwd);
      if (repoRoot) {
        // Use repo root as working directory (handles subdirectory case)
        effectiveCwd = repoRoot;
      } else if (dryRunFlag && command === 'workflow' && subcommand === 'run') {
        // Dry-run only discovers workflow files and simulates in memory. It does
        // not need project registration, a database lookup, or a git worktree.
        effectiveCwd = cwd;
      } else {
        // Not a git repo. It may still be a registered FOLDER project (a
        // multi-repo root or plain ops folder). Consult the DB before rejecting.
        // Canonicalize symlinks first so the lookup matches the realpath'd
        // default_cwd that registration stores: process.cwd() resolves symlinks,
        // but an explicit --cwd does not, so realpath here covers both. (cwd is
        // already validated to exist above; fall back to cwd if realpath fails.)
        let realCwd = cwd;
        try {
          realCwd = realpathSync(cwd);
        } catch {
          // keep the resolved cwd
        }
        // The DB may be unreachable. A lookup failure must NOT crash pre-dispatch
        // (workflow/isolation commands still need to surface a clear error rather
        // than a stack trace) — capture it and, if connection-shaped, report
        // "database unavailable" instead of the misleading "not a git repository".
        let folderCodebase: { default_cwd: string; kind: 'repo' | 'folder' } | null = null;
        let gateLookupError: Error | null = null;
        try {
          const codebaseDb = await import('@archon/core/db/codebases');
          folderCodebase =
            (await codebaseDb.findCodebaseByDefaultCwd(realCwd)) ??
            (await codebaseDb.findCodebaseByPathPrefix(realCwd));
        } catch (dbError) {
          gateLookupError = dbError as Error;
          getLog().warn(
            { err: gateLookupError, cwd: realCwd },
            'cli.folder_project_gate_lookup_failed'
          );
        }

        const looksLikeConnectionError = (e: Error): boolean => {
          const m = e.message.toLowerCase();
          return m.includes('econnrefused') || m.includes('etimedout') || m.includes('connect');
        };

        if (folderCodebase?.kind === 'folder') {
          // Registered folder project — run in place at its root.
          effectiveCwd = folderCodebase.default_cwd;
        } else if (folderFlag && command === 'workflow' && subcommand === 'run') {
          // First-use `workflow run --folder` from an unregistered non-git dir:
          // let it through so the run command registers the folder project.
          effectiveCwd = realCwd;
        } else if (gateLookupError && looksLikeConnectionError(gateLookupError)) {
          // A DB outage would otherwise be mis-reported as "not a git repository".
          console.error(
            'Error: Could not verify project registration — the database is unavailable.'
          );
          console.error(`  ${gateLookupError.message}`);
          console.error(
            '  Check that your database is running (or DATABASE_URL is set), then retry.'
          );
          return 1;
        } else {
          console.error('Error: Not in a git repository.');
          console.error('The Archon CLI must be run from within a git repository.');
          console.error('Either navigate to a git repo or use --cwd to specify one.');
          console.error(
            'Or register this folder as a project: run with --folder, or use /register-project in chat.'
          );
          return 1;
        }
      }
    }

    switch (command) {
      case 'version':
        await versionCommand();
        break;

      case 'help':
        printUsage();
        break;

      case 'chat': {
        const chatMessage = positionals.slice(1).join(' ');
        if (!chatMessage) {
          console.error('Usage: archon chat <message>');
          return 1;
        }
        await chatCommand(chatMessage);
        break;
      }

      case 'setup': {
        const rawScope = values.scope as string | undefined;
        if (rawScope !== undefined && rawScope !== 'home' && rawScope !== 'project') {
          console.error(`Error: Invalid --scope: "${rawScope}". Must be "home" or "project".`);
          return 1;
        }
        const scope: 'home' | 'project' = rawScope ?? 'home';
        const forceFlag = (values.force as boolean | undefined) ?? false;
        // For --scope project, resolve to the git repo root so running from a
        // subdirectory writes to <repo-root>/.archon/.env (what loadArchonEnv
        // reads at boot) — not <subdir>/.archon/.env.
        let repoPath = cwd;
        if (scope === 'project') {
          const repoRoot = await git.findRepoRoot(cwd);
          if (!repoRoot) {
            console.error('Error: --scope project requires running from inside a git repository.');
            console.error('Run from the repo root, pass --cwd <repo>, or use --scope home.');
            return 1;
          }
          repoPath = repoRoot;
        }
        await setupCommand({ spawn: spawnFlag, repoPath, scope, force: forceFlag });
        break;
      }

      case 'workflow':
        if (
          values.model !== undefined &&
          (subcommand === 'resume' ||
            subcommand === 'approve' ||
            subcommand === 'reject' ||
            subcommand === 'respond')
        ) {
          console.error(
            'Error: --model cannot be used when continuing an existing workflow run. ' +
              'The run keeps the model bindings it started with.'
          );
          return 1;
        }
        switch (subcommand) {
          case 'list':
            await workflowListCommand(effectiveCwd, jsonFlag);
            break;

          case 'run': {
            const workflowName = positionals[2];
            if (!workflowName) {
              console.error('Usage: archon workflow run <name> [message]');
              return 1;
            }
            const userMessage = positionals.slice(3).join(' ') || '';
            if (branchName !== undefined && noWorktree) {
              console.error(
                'Error: --branch and --no-worktree are mutually exclusive.\n' +
                  '  --branch creates an isolated worktree (safe).\n' +
                  '  --no-worktree runs directly in your repo (no isolation).\n' +
                  'Use one or the other.'
              );
              return 1;
            }
            if (noWorktree && fromBranch !== undefined) {
              console.error(
                'Error: --from/--from-branch has no effect with --no-worktree.\n' +
                  'Remove --from or drop --no-worktree.'
              );
              return 1;
            }
            if (noWorktree && baseBranch !== undefined) {
              console.error(
                'Error: --base has no effect with --no-worktree.\n' +
                  'Remove --base or drop --no-worktree.'
              );
              return 1;
            }
            if (resumeFlag && branchName !== undefined) {
              console.error(
                'Error: --resume and --branch are mutually exclusive.\n' +
                  '  --resume reuses the existing worktree from the failed run.\n' +
                  '  Remove --branch when using --resume.'
              );
              return 1;
            }
            // `--workflow-source` picks the authoring directory. It is fresh-run only:
            // a resume executes the source its run already captured, so accepting a
            // different one here would promise a swap that cannot happen.
            let workflowSource: string | undefined;
            if (workflowSourceFlag !== undefined) {
              if (resumeFlag) {
                console.error(
                  'Error: --workflow-source and --resume are mutually exclusive.\n' +
                    '  A resumed run executes the source it captured when it started.\n' +
                    '  Drop --workflow-source, or start a fresh run to pick up new source.'
                );
                return 1;
              }
              if (containerFlag) {
                // A container run executes inside the container, which mounts the folder
                // project and nothing else. The capture lives outside that mount, so a
                // separate source root could be frozen but never read — the run would
                // fail looking for its own commands. Refuse the combination rather than
                // ship a flag that silently does not apply.
                console.error(
                  'Error: --workflow-source and --container are mutually exclusive.\n' +
                    '  A container run reads source from the project it mounts.\n' +
                    '  Run without --container to execute source from another directory.'
                );
                return 1;
              }
              workflowSource = resolve(workflowSourceFlag);
              if (!(await isPathDirectory(workflowSource))) {
                console.error(
                  `Error: --workflow-source is not a directory: ${workflowSource}\n` +
                    '  Point it at the checkout holding .archon/workflows/.'
                );
                return 1;
              }
            }
            const options = {
              branchName,
              fromBranch,
              baseBranch,
              // `--workflow-source` selects WHERE the workflow is read from; `--cwd`
              // continues to select what it acts on. Reusing `discoveryCwd` keeps one
              // internal concept: the directory discovery searches, which the run then
              // freezes as its source.
              discoveryCwd: workflowSource,
              noWorktree,
              folder: folderFlag,
              container: containerFlag,
              resume: resumeFlag,
              quiet: values.quiet as boolean | undefined,
              verbose: values.verbose as boolean | undefined,
              // Stable scope for persist_session across separate CLI invocations. Without
              // it each run gets a fresh conversation UUID, so persisted sessions never
              // resume between runs (they only resume within chat/REST, which reuse a
              // conversation). Pass the same id on each run to opt into cross-run resume.
              conversationId: values['conversation-id'] as string | undefined,
              detach: detachFlag,
              json: jsonFlag,
              dryRun: dryRunFlag,
              stubsPath,
              stubsInitPath,
              defaultStubs: defaultStubsFlag,
              execCode: execCodeFlag,
              pauseAtGates: pauseAtGatesFlag,
              // Raw `name=value` assignments; parsed at the invocation gate (#2554).
              inputs: values.input as string[] | undefined,
              modelAssignments: values.model as string[] | undefined,
            };
            await workflowRunCommand(effectiveCwd, workflowName, userMessage, options);
            break;
          }

          case 'status':
            if (positionals[2] !== undefined) {
              console.error(
                'Usage: archon workflow status [--json] [--verbose] [--events]\n' +
                  'To show a single run, use: archon workflow get <run-id>'
              );
              return 1;
            }
            await workflowStatusCommand(
              jsonFlag,
              values.verbose as boolean | undefined,
              values.events as boolean | undefined
            );
            break;

          case 'get': {
            const getRunId = positionals[2];
            if (!getRunId || positionals[3] !== undefined) {
              console.error('Usage: archon workflow get <run-id> [--json] [--verbose] [--events]');
              return 1;
            }
            // Propagate the command's exit code so `get <id> && ...` and CI
            // pipelines see a non-zero status when the run is missing.
            return await workflowGetCommand(
              getRunId,
              jsonFlag,
              values.verbose as boolean | undefined,
              effectiveCwd,
              values.events as boolean | undefined
            );
          }

          case 'runs': {
            const rawLimit = values.limit as string | undefined;
            let limit: number | undefined;
            if (rawLimit !== undefined) {
              limit = Number(rawLimit);
              if (!Number.isInteger(limit) || limit < 1) {
                console.error(`Error: --limit must be a positive integer, got '${rawLimit}'.`);
                return 1;
              }
            }
            await workflowRunsCommand(effectiveCwd, {
              json: jsonFlag,
              all: values.all as boolean | undefined,
              status: values.status as string | undefined,
              limit,
            });
            break;
          }

          case 'resume': {
            const resumeRunId = positionals[2];
            if (!resumeRunId) {
              console.error('Usage: archon workflow resume <run-id>');
              return 1;
            }
            await workflowResumeCommand(resumeRunId, jsonFlag, effectiveCwd, detachFlag);
            break;
          }

          case 'abandon': {
            const abandonRunId = positionals[2];
            if (!abandonRunId) {
              console.error('Usage: archon workflow abandon <run-id>');
              return 1;
            }
            await workflowAbandonCommand(abandonRunId, jsonFlag, effectiveCwd);
            break;
          }

          case 'cancel': {
            const cancelRunId = positionals[2];
            if (!cancelRunId) {
              console.error('Usage: archon workflow cancel <run-id>');
              return 1;
            }
            await workflowCancelCommand(cancelRunId, jsonFlag, effectiveCwd);
            break;
          }

          case 'approve': {
            const approveRunId = positionals[2];
            if (!approveRunId) {
              console.error('Usage: archon workflow approve <run-id> [comment]');
              return 1;
            }
            // Accept comment as positional args (everything after run ID) or --comment flag.
            // Explicit empty→undefined conversion (not `|| undefined`): "no comment" must
            // reach approveWorkflow as undefined so a signal-bearing interactive-loop gate
            // finalizes instead of re-running (#2074, loop_feedback_given).
            const rawApproveComment =
              (values.comment as string | undefined) || positionals.slice(3).join(' ');
            const approveComment = rawApproveComment.length > 0 ? rawApproveComment : undefined;
            await workflowApproveCommand(
              approveRunId,
              approveComment,
              jsonFlag,
              effectiveCwd,
              detachFlag
            );
            break;
          }

          case 'reject': {
            const rejectRunId = positionals[2];
            if (!rejectRunId) {
              console.error('Usage: archon workflow reject <run-id> [reason]');
              return 1;
            }
            const rawRejectReason =
              (values.reason as string | undefined) || positionals.slice(3).join(' ');
            const rejectReason = rawRejectReason.length > 0 ? rawRejectReason : undefined;
            await workflowRejectCommand(
              rejectRunId,
              rejectReason,
              jsonFlag,
              effectiveCwd,
              detachFlag
            );
            break;
          }

          case 'respond': {
            const respondRunId = positionals[2];
            const decision = positionals[3];
            if (!respondRunId || !decision) {
              console.error('Usage: archon workflow respond <run-id> <decision> [text]');
              console.error(
                "  'approve' and 'reject' are sugar for the equivalent dedicated commands; " +
                  'any other decision must be one the gate actually declared.'
              );
              return 1;
            }
            const rawRespondText =
              (values.text as string | undefined) || positionals.slice(4).join(' ');
            const respondText = rawRespondText.length > 0 ? rawRespondText : undefined;
            await workflowRespondCommand(
              respondRunId,
              decision,
              respondText,
              jsonFlag,
              effectiveCwd,
              detachFlag
            );
            break;
          }

          case 'cleanup': {
            const days = positionals[2] ? Number(positionals[2]) : 7;
            if (Number.isNaN(days) || days < 0) {
              console.error('Usage: archon workflow cleanup [days]');
              console.error('  days: delete terminal runs older than N days (default: 7)');
              return 1;
            }
            await workflowCleanupCommand(days);
            break;
          }

          case 'reset-sessions': {
            const workflowName = positionals[2];
            const extras = positionals.slice(3);
            if (!workflowName) {
              console.error(
                'Usage: archon workflow reset-sessions <workflow-name> [--scope <key>] [--node <id>] [--yes] [--json]'
              );
              console.error(
                '  Without --scope: deletes persisted sessions across ALL scopes (requires --yes).'
              );
              return 1;
            }
            // Reject extra positionals — this is a destructive command and silently
            // dropping `archon workflow reset-sessions wf planner` (likely intent: filter to
            // node "planner") to a cross-scope wipe would be a foot-gun.
            if (extras.length > 0) {
              console.error(
                'Usage: archon workflow reset-sessions <workflow-name> [--scope <key>] [--node <id>] [--yes] [--json]'
              );
              console.error(
                `Error: unexpected positional argument(s): ${extras.join(' ')}. Use --node <id> to filter by node.`
              );
              return 1;
            }
            await workflowResetSessionsCommand(workflowName, {
              scope: values.scope as string | undefined,
              node: values.node as string | undefined,
              yes: values.yes as boolean | undefined,
              json: jsonFlag,
            });
            break;
          }

          case 'event': {
            const action = positionals[2];
            if (action !== 'emit') {
              if (action === undefined) {
                console.error('Missing workflow event subcommand');
              } else {
                console.error(`Unknown workflow event subcommand: ${action}`);
              }
              console.error('Available: emit');
              return 1;
            }
            const runId = values['run-id'] as string | undefined;
            const eventType = values.type as string | undefined;
            if (!runId) {
              console.error(
                'Usage: archon workflow event emit --run-id <run-id> --type <event-type>'
              );
              console.error('Error: --run-id is required');
              return 1;
            }
            if (!eventType) {
              console.error(
                'Usage: archon workflow event emit --run-id <run-id> --type <event-type>'
              );
              console.error('Error: --type is required');
              return 1;
            }
            if (!isValidEventType(eventType)) {
              console.error(`Error: unknown event type: ${eventType}`);
              console.error(`Valid types: ${WORKFLOW_EVENT_TYPES.join(', ')}`);
              return 1;
            }
            let eventData: Record<string, unknown> | undefined;
            const rawData = values.data as string | undefined;
            if (rawData) {
              try {
                eventData = JSON.parse(rawData) as Record<string, unknown>;
              } catch {
                console.warn(
                  `Warning: --data is not valid JSON — event will be emitted without data payload: ${rawData}`
                );
              }
            }
            await workflowEventEmitCommand(runId, eventType, eventData, effectiveCwd);
            break;
          }

          case 'install': {
            const installSlug = positionals[2];
            if (!installSlug) {
              console.error('Usage: archon workflow install <slug> [--force]');
              return 1;
            }
            const forceFlag = values.force as boolean | undefined;
            await workflowInstallCommand(installSlug, effectiveCwd, forceFlag);
            break;
          }

          default:
            if (subcommand === undefined) {
              console.error('Missing workflow subcommand');
            } else {
              console.error(`Unknown workflow subcommand: ${subcommand}`);
            }
            console.error(
              'Available: list, run, status, get, runs, resume, cancel, abandon, approve, reject, cleanup, event, search, install'
            );
            return 1;
        }
        break;

      case 'isolation':
        switch (subcommand) {
          case 'list':
            await isolationListCommand();
            break;

          case 'cleanup': {
            if (values.merged) {
              await isolationCleanupMergedCommand({
                includeClosed: Boolean(values['include-closed']),
              });
            } else {
              const days = parseInt(positionals[2] ?? '7', 10);
              await isolationCleanupCommand(days);
            }
            break;
          }

          default:
            if (subcommand === undefined) {
              console.error('Missing isolation subcommand');
            } else {
              console.error(`Unknown isolation subcommand: ${subcommand}`);
            }
            console.error('Available: list, cleanup');
            return 1;
        }
        break;

      case 'validate':
        switch (subcommand) {
          case 'workflows': {
            const validateName = positionals[2];
            return await validateWorkflowsCommand(effectiveCwd, validateName, jsonFlag);
          }

          case 'commands': {
            const validateName = positionals[2];
            return await validateCommandsCommand(effectiveCwd, validateName, jsonFlag);
          }

          default:
            if (subcommand === undefined) {
              console.error('Missing validate target');
            } else {
              console.error(`Unknown validate target: ${subcommand}`);
            }
            console.error('Available: workflows, commands');
            return 1;
        }

      case 'complete': {
        const branches = positionals.slice(1);
        if (branches.length === 0) {
          console.error('Usage: archon complete <branch-name> [branch2 ...]');
          return 1;
        }
        const forceFlag = Boolean(values.force);
        await isolationCompleteCommand(branches, { force: forceFlag, deleteRemote: true });
        break;
      }

      case 'continue': {
        const continueBranch = positionals[1];
        if (!continueBranch) {
          console.error('Usage: archon continue <branch> [--workflow <name>] "instruction"');
          return 1;
        }
        const continueMessage = positionals.slice(2).join(' ') || '';
        const continueWorkflow = values.workflow as string | undefined;
        const noContextFlag = values['no-context'] as boolean | undefined;
        await continueCommand(continueBranch, continueMessage, {
          workflow: continueWorkflow,
          noContext: noContextFlag,
        });
        break;
      }

      case 'serve': {
        const servePort = values.port !== undefined ? Number(values.port) : undefined;
        const downloadOnly = Boolean(values['download-only']);
        return await serveCommand({ port: servePort, downloadOnly });
      }

      case 'doctor': {
        return await doctorCommand(undefined, Boolean(values.full));
      }

      case 'auth': {
        switch (subcommand) {
          case 'github':
            return await authGithubCommand();
          default:
            if (subcommand === undefined) {
              console.error('Missing auth subcommand');
            } else {
              console.error(`Unknown auth subcommand: ${subcommand}`);
            }
            console.error('Available: github');
            return 1;
        }
      }

      case 'ai': {
        switch (subcommand) {
          case 'key': {
            const action = positionals[2];
            if (action !== 'set') {
              console.error('Usage: archon ai key set <provider>');
              return 1;
            }
            return await aiKeySetCommand(positionals[3]);
          }
          case 'list':
            return await aiListCommand();
          case 'logout':
            return await aiLogoutCommand(positionals[2]);
          case 'login':
            return await aiLoginCommand(positionals[2]);
          case 'tier': {
            const action = positionals[2];
            const scopeFlag = values.scope as string | undefined;
            switch (action) {
              case 'set':
                return await aiTierSetCommand(
                  positionals[3],
                  positionals[4],
                  positionals[5],
                  values.effort as string | undefined,
                  scopeFlag
                );
              case 'list':
                return await aiTierListCommand(jsonFlag);
              case 'unset':
                return await aiTierUnsetCommand(positionals[3], scopeFlag);
              default:
                console.error(
                  'Usage: archon ai tier set <small|medium|large> <provider> <model> [--effort <e>] [--scope user|install] | tier list [--json] | tier unset <tier> [--scope user|install]'
                );
                return 1;
            }
          }
          case 'alias': {
            const action = positionals[2];
            const scopeFlag = values.scope as string | undefined;
            switch (action) {
              case 'set':
                return await aiAliasSetCommand(
                  positionals[3],
                  positionals[4],
                  positionals[5],
                  values.effort as string | undefined,
                  scopeFlag
                );
              case 'list':
                return await aiAliasListCommand(jsonFlag);
              case 'unset':
                return await aiAliasUnsetCommand(positionals[3], scopeFlag);
              default:
                console.error(
                  'Usage: archon ai alias set <@name> <provider> <model> [--effort <e>] [--scope user|install] | alias list [--json] | alias unset <@name> [--scope user|install]'
                );
                return 1;
            }
          }
          case 'default':
            return await aiDefaultCommand(
              positionals[2],
              positionals[3],
              values.scope as string | undefined
            );
          default:
            if (subcommand === undefined) {
              console.error('Missing ai subcommand');
            } else {
              console.error(`Unknown ai subcommand: ${subcommand}`);
            }
            console.error(
              'Available: key set <provider>, login <provider>, list, logout <provider>, tier set|list|unset, alias set|list|unset, default <provider> [<model>]'
            );
            return 1;
        }
      }

      case 'telemetry': {
        switch (subcommand) {
          case 'status':
            return telemetryStatusCommand();
          case 'reset':
            return telemetryResetCommand();
          default:
            if (subcommand === undefined) {
              console.error('Missing telemetry subcommand');
            } else {
              console.error(`Unknown telemetry subcommand: ${subcommand}`);
            }
            console.error('Available: status, reset');
            return 1;
        }
      }

      case 'skill': {
        switch (subcommand) {
          case 'install': {
            // Optional positional path; otherwise install into the resolved cwd.
            const targetArg = positionals[2];
            const targetPath = targetArg ? resolve(targetArg) : cwd;
            return await skillInstallCommand(targetPath);
          }

          default:
            if (subcommand === undefined) {
              console.error('Missing skill subcommand');
            } else {
              console.error(`Unknown skill subcommand: ${subcommand}`);
            }
            console.error('Available: install');
            return 1;
        }
      }

      default:
        if (command === undefined) {
          console.error('Missing command');
        } else {
          console.error(`Unknown command: ${command}`);
        }
        printUsage();
        return 1;
    }
    await printUpdateNotice(values.quiet as boolean | undefined);
    return 0;
  } catch (error) {
    const err = error as Error;
    console.error(`Error: ${err.message}`);
    if (process.env.DEBUG) {
      console.error(err.stack);
    }
    return 1;
  } finally {
    // Flush queued telemetry events before the CLI process exits.
    // Short-lived CLI commands lose buffered events if shutdown() is skipped.
    await shutdownTelemetry();
    // Always close database connection
    await closeDb();
  }
}

// Exit explicitly so a lingering handle (DB pool, spawned child, timer) can
// never leave the CLI hanging after its work is done.
//
// `flushPendingWrites()` is awaited BEFORE `process.exit()` because every
// `console.log` written through the pipe-safe shim is fire-and-forget
// (src/utils/safe-console.ts): the stream callback that resolves the per-
// write promise fires asynchronously, and `process.exit()` does not drain
// `process.stdout`'s pending writes. Without this flush a very-slow reader
// (e.g. `archon … | { sleep 1; cat; }`) would re-introduce the silent-exit-0
// truncation the shim is meant to eliminate — see R1 in the review report.
//
// The `--json` paths do not need this because every JSON emitter already
// awaits `writeStdout` / `writeJsonLine` at the call site
// (src/utils/stdout.ts); the shim only adds the fire-and-forget shape that
// the human-readable call surface requires.
//
// The drain runs on BOTH exits — success and fatal — so a `main()` rejection
// does not get to drop queued stdout bytes just because it is exiting non-
// zero. Splitting the two arms' exit logic would re-open the R9 latency:
// a fatal rejection against a slow reader would truncate and exit 1,
// producing the same silent stdout loss the patch is meant to eliminate.
// The chain wiring — `main().then(exitWithDrain).catch(...)` — lives in
// `withDrainedExit` (`./utils/exit-with-drain.ts`) so cli.ts and the R9
// regression test fixture share a single source of truth. A regression
// that swaps this call for a direct `process.exit` is caught by the
// static-contract test in `safe-console.test.ts`, which reads this file
// as text.
withDrainedExit(main);
