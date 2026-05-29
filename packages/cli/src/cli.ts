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

import { parseArgs } from 'util';
import { resolve } from 'path';
import { existsSync } from 'fs';

// CLAUDECODE=1 warning is emitted inside stripCwdEnv() (boot import above)
// BEFORE the marker is deleted from process.env. No duplicate warning here.

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
  workflowResumeCommand,
  workflowAbandonCommand,
  workflowApproveCommand,
  workflowRejectCommand,
  workflowCleanupCommand,
  workflowResetSessionsCommand,
  workflowEventEmitCommand,
  workflowSearchCommand,
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
import { setupCommand } from './commands/setup';
import { skillInstallCommand } from './commands/skill';
import { validateWorkflowsCommand, validateCommandsCommand } from './commands/validate';
import { serveCommand } from './commands/serve';
import { doctorCommand } from './commands/doctor';
import { telemetryStatusCommand, telemetryResetCommand } from './commands/telemetry';
import {
  codebaseListCommand,
  codebaseGetCommand,
  codebaseRegisterCommand,
  codebaseDeleteCommand,
  codebaseEnvListCommand,
  codebaseEnvSetCommand,
  codebaseEnvDeleteCommand,
  codebaseEnvironmentsCommand,
} from './commands/codebase';
import {
  conversationListCommand,
  conversationGetCommand,
  conversationMessagesCommand,
  conversationCreateCommand,
  conversationTitleCommand,
  conversationDeleteCommand,
} from './commands/conversation';
import { providersListCommand } from './commands/providers';
import { configShowCommand, configAssistantCommand, configPathCommand } from './commands/config';
import { healthCommand } from './commands/health';
import { updateCheckCommand } from './commands/update-check';
import {
  workflowGetCommand,
  workflowCreateCommand,
  workflowUpdateCommand,
  workflowDeleteCommand,
  workflowCancelCommand,
  workflowRunsCommand,
  workflowInspectCommand,
  workflowArtifactsListCommand,
  workflowArtifactsGetCommand,
} from './commands/workflow-manage';
import { closeDatabase } from '@archon/core';
import {
  setLogLevel,
  createLogger,
  checkForUpdate,
  BUNDLED_IS_BINARY,
  BUNDLED_VERSION,
  shutdownTelemetry,
  isVerboseBoot,
} from '@archon/paths';
import * as git from '@archon/git';

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
  setup                      Interactive setup wizard for credentials and config
  workflow list              List available workflows in current directory
  workflow run <name> [msg]  Run a workflow with optional message
  workflow status            Show status of running workflows
  workflow search [query]    Search the workflow marketplace
  workflow install <slug>    Install a workflow from the marketplace
  isolation list             List all active worktrees/environments
  isolation cleanup [days]   Remove stale environments (default: 7 days)
  isolation cleanup --merged Remove environments with branches merged into main
  continue <branch> [msg]    Continue work on an existing worktree with prior context
  complete <branch> [...]    Complete branch lifecycle (remove worktree + branches)
  serve                      Start the web UI server (downloads web UI on first run)
  skill install [path]       Install the bundled Archon skill into .claude/skills/archon
  doctor                     Verify your Archon setup (Claude binary, gh auth, DB, adapters)
  telemetry status           Show anonymous telemetry state (enabled, reason, ID, host)
  telemetry reset            Rotate the anonymous install UUID
  validate workflows [name]  Validate workflow definitions and their references
  validate commands [name]   Validate command files
  codebase list|get|register|delete            Manage codebases
  codebase env list|set|delete <id|name>       Manage codebase env vars (values hidden)
  codebase environments <id|name>              List isolation environments
  conversation list|get|messages <id>          Inspect conversations
  conversation create|title|delete             Manage conversations
  workflow get|create|update|delete <name>     Manage workflow definitions
  workflow runs|inspect|cancel                 Inspect & control workflow runs
  workflow artifacts list|get <run-id>         Read run artifacts
  config show|assistant|path                   Inspect & update configuration
  providers list                               List registered AI providers
  health                                       Server runtime health check
  update-check                                 Check for a newer Archon release
  version, --version, -V     Show version info (also -v when used alone)
  help                       Show this help message

Options:
  --cwd <path>               Override working directory (default: current directory)
  --branch, -b <name>        Create worktree for branch (or reuse existing)
  --from, --from-branch <name> Create new branch from specific start point
  --no-worktree              Run on branch directly without worktree isolation
  --resume                   Resume the most recent failed run of the workflow (mutually exclusive with --branch)
  --spawn                    Open setup wizard in a new terminal window (for setup command)
  --quiet, -q                Reduce log verbosity to warnings and errors only
  --verbose, -v              Show debug-level output
  --json                     Output machine-readable JSON (for workflow list)
  --workflow <name>          Workflow to run for 'continue' (default: archon-assist)
  --no-context               Skip context injection for 'continue'
  --conversation-id <id>     Reuse a stable conversation scope across runs (enables
                             persist_session resume between separate CLI invocations)
  --port <port>              Override server port for 'serve' (default: 3090)
  --download-only            Download web UI without starting the server
  --force                    Overwrite existing file / skip delete confirmation
  --server-url <url>         Archon server URL for mutations (default: http://localhost:3090, or ARCHON_SERVER_URL)
  --limit <n>                Max rows for list commands
  --status <status>          Filter workflow runs by status
  --name <name>              Workflow name override (workflow create)
  --title <title>            Conversation title (conversation create/title)
  --model <model>            Set model (config assistant)
  --setting-sources <a,b>    Set Claude settingSources (config assistant)
  --source <project|global>  Workflow source filter (workflow delete)
  --output <file>            Write artifact to file (workflow artifacts get)

Examples:
  archon workflow list
  archon workflow run investigate-issue "Fix the login bug"
  archon workflow run plan --cwd /path/to/repo "Add dark mode"
  archon workflow run implement --branch feature-auth "Implement auth"
  archon workflow run quick-fix --no-worktree "Fix typo"
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

  // Handle no arguments - show help and exit successfully
  if (args.length === 0) {
    printUsage();
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
      options: {
        cwd: { type: 'string', default: process.cwd() },
        help: { type: 'boolean', short: 'h' },
        branch: { type: 'string', short: 'b' },
        from: { type: 'string' },
        'from-branch': { type: 'string' },
        'no-worktree': { type: 'boolean' },
        resume: { type: 'boolean' },
        spawn: { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
        verbose: { type: 'boolean', short: 'v' },
        json: { type: 'boolean' },
        'run-id': { type: 'string' },
        type: { type: 'string' },
        data: { type: 'string' },
        comment: { type: 'string' },
        reason: { type: 'string' },
        workflow: { type: 'string' },
        'no-context': { type: 'boolean' },
        port: { type: 'string' },
        'download-only': { type: 'boolean' },
        scope: { type: 'string' },
        node: { type: 'string' },
        yes: { type: 'boolean' },
        force: { type: 'boolean' },
        'conversation-id': { type: 'string' },
        'server-url': { type: 'string' },
        limit: { type: 'string' },
        name: { type: 'string' },
        status: { type: 'string' },
        title: { type: 'string' },
        model: { type: 'string' },
        'setting-sources': { type: 'string' },
        source: { type: 'string' },
        output: { type: 'string' },
      },
      allowPositionals: true,
      strict: false, // Allow unknown flags to pass through
    });
  } catch (error) {
    const err = error as Error;
    console.error(`Error parsing arguments: ${err.message}`);
    printUsage();
    return 1;
  }

  const { values, positionals } = parsedArgs;
  const cwdValue = values.cwd;
  const cwd = resolve(typeof cwdValue === 'string' ? cwdValue : process.cwd());
  const branchName = values.branch as string | undefined;
  const fromBranch =
    (values.from as string | undefined) ?? (values['from-branch'] as string | undefined);
  const noWorktree = values['no-worktree'] as boolean | undefined;
  const resumeFlag = values.resume as boolean | undefined;
  const spawnFlag = values.spawn as boolean | undefined;
  const jsonFlag = values.json as boolean | undefined;
  const serverUrl = values['server-url'] as string | undefined;
  const nameFlag = values.name as string | undefined;
  const statusFlag = values.status as string | undefined;
  const titleFlag = values.title as string | undefined;
  const modelFlag = values.model as string | undefined;
  const settingSourcesFlag = values['setting-sources'] as string | undefined;
  // `--source` is a string flag (workflow delete), but parseArgs sets it to
  // `true` when passed without a value — coerce non-strings to undefined.
  const sourceFlag = typeof values.source === 'string' ? values.source : undefined;
  const outputFlag = values.output as string | undefined;
  const rawLimit = values.limit;
  const limitFlag =
    rawLimit !== undefined && Number.isFinite(Number(rawLimit)) && Number(rawLimit) > 0
      ? Number(rawLimit)
      : undefined;
  // Handle help flag
  if (values.help) {
    printUsage();
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
    'continue',
    'serve',
    'skill',
    'doctor',
    'telemetry',
    'codebase',
    'conversation',
    'providers',
    'config',
    'health',
    'update-check',
  ];
  // New workflow subcommands operate on the global DB / REST API / cwd and do
  // not resolve a repo root, so (unlike `run`, `resume`, etc.) they don't
  // require a git repository.
  const workflowNoGitSubcommands = new Set([
    'get',
    'create',
    'update',
    'delete',
    'cancel',
    'runs',
    'inspect',
    'artifacts',
  ]);
  const requiresGitRepo =
    !noGitCommands.includes(command ?? '') &&
    !(command === 'workflow' && workflowNoGitSubcommands.has(subcommand ?? ''));

  try {
    // setup/doctor/telemetry default to warn to avoid Pino info JSON interleaving with their human-readable output.
    // --json commands also suppress info logs so stdout stays clean, parseable JSON
    // (e.g. `archon codebase list --json | jq`); --verbose overrides. Lazy loggers
    // pick up this level at first creation.
    const isInteractiveCommand =
      command === 'setup' || command === 'doctor' || command === 'telemetry';
    const suppressByDefault =
      (isInteractiveCommand || jsonFlag === true) && !values.verbose && !isVerboseBoot();
    if (values.quiet || suppressByDefault) {
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

    // Validate working directory exists
    let effectiveCwd = cwd;
    if (requiresGitRepo) {
      if (!existsSync(cwd)) {
        console.error(`Error: Directory does not exist: ${cwd}`);
        return 1;
      }

      // Validate git repository and resolve to root
      const repoRoot = await git.findRepoRoot(cwd);
      if (!repoRoot) {
        console.error('Error: Not in a git repository.');
        console.error('The Archon CLI must be run from within a git repository.');
        console.error('Either navigate to a git repo or use --cwd to specify one.');
        return 1;
      }
      // Use repo root as working directory (handles subdirectory case)
      effectiveCwd = repoRoot;
    }

    switch (command) {
      case 'version':
        await versionCommand();
        break;

      case 'help':
        printUsage();
        break;

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
            if (resumeFlag && branchName !== undefined) {
              console.error(
                'Error: --resume and --branch are mutually exclusive.\n' +
                  '  --resume reuses the existing worktree from the failed run.\n' +
                  '  Remove --branch when using --resume.'
              );
              return 1;
            }
            const options = {
              branchName,
              fromBranch,
              noWorktree,
              resume: resumeFlag,
              quiet: values.quiet as boolean | undefined,
              verbose: values.verbose as boolean | undefined,
              // Stable scope for persist_session across separate CLI invocations. Without
              // it each run gets a fresh conversation UUID, so persisted sessions never
              // resume between runs (they only resume within chat/REST, which reuse a
              // conversation). Pass the same id on each run to opt into cross-run resume.
              conversationId: values['conversation-id'] as string | undefined,
            };
            await workflowRunCommand(effectiveCwd, workflowName, userMessage, options);
            break;
          }

          case 'status':
            await workflowStatusCommand(jsonFlag, values.verbose as boolean | undefined);
            break;

          case 'resume': {
            const resumeRunId = positionals[2];
            if (!resumeRunId) {
              console.error('Usage: archon workflow resume <run-id>');
              return 1;
            }
            await workflowResumeCommand(resumeRunId);
            break;
          }

          case 'abandon': {
            const abandonRunId = positionals[2];
            if (!abandonRunId) {
              console.error('Usage: archon workflow abandon <run-id>');
              return 1;
            }
            await workflowAbandonCommand(abandonRunId);
            break;
          }

          case 'approve': {
            const approveRunId = positionals[2];
            if (!approveRunId) {
              console.error('Usage: archon workflow approve <run-id> [comment]');
              return 1;
            }
            // Accept comment as positional args (everything after run ID) or --comment flag
            const approveComment =
              (values.comment as string | undefined) || positionals.slice(3).join(' ') || undefined;
            await workflowApproveCommand(approveRunId, approveComment);
            break;
          }

          case 'reject': {
            const rejectRunId = positionals[2];
            if (!rejectRunId) {
              console.error('Usage: archon workflow reject <run-id> [reason]');
              return 1;
            }
            const rejectReason =
              (values.reason as string | undefined) || positionals.slice(3).join(' ') || undefined;
            await workflowRejectCommand(rejectRunId, rejectReason);
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
                'Usage: archon workflow event emit --run-id <uuid> --type <event-type>'
              );
              console.error('Error: --run-id is required');
              return 1;
            }
            if (!eventType) {
              console.error(
                'Usage: archon workflow event emit --run-id <uuid> --type <event-type>'
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
            await workflowEventEmitCommand(runId, eventType, eventData);
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

          case 'get': {
            const getName = positionals[2];
            if (!getName) {
              console.error('Usage: archon workflow get <name> [--json]');
              return 1;
            }
            await workflowGetCommand(getName, effectiveCwd, { json: jsonFlag });
            break;
          }

          case 'create': {
            const createFile = positionals[2];
            if (!createFile) {
              console.error('Usage: archon workflow create <file> [--name <name>] [--cwd <path>]');
              return 1;
            }
            await workflowCreateCommand(createFile, effectiveCwd, { name: nameFlag }, serverUrl);
            break;
          }

          case 'update': {
            const updateName = positionals[2];
            const updateFile = positionals[3];
            if (!updateName || !updateFile) {
              console.error('Usage: archon workflow update <name> <file> [--cwd <path>]');
              return 1;
            }
            await workflowUpdateCommand(updateName, updateFile, effectiveCwd, serverUrl);
            break;
          }

          case 'delete': {
            const deleteName = positionals[2];
            if (!deleteName) {
              console.error(
                'Usage: archon workflow delete <name> [--force] [--source project|global]'
              );
              return 1;
            }
            await workflowDeleteCommand(
              deleteName,
              effectiveCwd,
              { force: values.force as boolean | undefined, source: sourceFlag },
              serverUrl
            );
            break;
          }

          case 'cancel': {
            const cancelRunId = positionals[2];
            if (!cancelRunId) {
              console.error('Usage: archon workflow cancel <run-id>');
              return 1;
            }
            await workflowCancelCommand(cancelRunId, serverUrl);
            break;
          }

          case 'runs':
            await workflowRunsCommand({
              status: statusFlag,
              limit: limitFlag,
              workflow: values.workflow as string | undefined,
              json: jsonFlag,
            });
            break;

          case 'inspect': {
            const inspectRunId = positionals[2];
            if (!inspectRunId) {
              console.error('Usage: archon workflow inspect <run-id> [--json]');
              return 1;
            }
            await workflowInspectCommand(inspectRunId, jsonFlag);
            break;
          }

          case 'artifacts': {
            const artifactsAction = positionals[2];
            if (artifactsAction === 'list') {
              const listRunId = positionals[3];
              if (!listRunId) {
                console.error('Usage: archon workflow artifacts list <run-id> [--json]');
                return 1;
              }
              await workflowArtifactsListCommand(listRunId, jsonFlag);
            } else if (artifactsAction === 'get') {
              const getRunId = positionals[3];
              const getPath = positionals[4];
              if (!getRunId || !getPath) {
                console.error(
                  'Usage: archon workflow artifacts get <run-id> <path> [--output <file>]'
                );
                return 1;
              }
              await workflowArtifactsGetCommand(getRunId, getPath, { output: outputFlag });
            } else {
              console.error('Usage: archon workflow artifacts <list|get> ...');
              return 1;
            }
            break;
          }

          default:
            if (subcommand === undefined) {
              console.error('Missing workflow subcommand');
            } else {
              console.error(`Unknown workflow subcommand: ${subcommand}`);
            }
            console.error(
              'Available: list, run, status, resume, abandon, approve, reject, cleanup, event, ' +
                'search, install, get, create, update, delete, cancel, runs, inspect, artifacts'
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
            // Check for --merged flag in remaining args
            const mergedFlag = args.includes('--merged') || positionals.includes('--merged');
            if (mergedFlag) {
              const includeClosed = args.includes('--include-closed');
              await isolationCleanupMergedCommand({ includeClosed });
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
        const forceFlag = args.includes('--force');
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
        return await doctorCommand();
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

      case 'codebase':
        switch (subcommand) {
          case 'list':
            await codebaseListCommand(jsonFlag);
            break;

          case 'get': {
            const cbId = positionals[2];
            if (!cbId) {
              console.error('Usage: archon codebase get <id|name> [--json]');
              return 1;
            }
            await codebaseGetCommand(cbId, jsonFlag);
            break;
          }

          case 'register': {
            const target = positionals[2];
            if (!target) {
              console.error('Usage: archon codebase register <path|url>');
              return 1;
            }
            await codebaseRegisterCommand(target, serverUrl);
            break;
          }

          case 'delete': {
            const cbId = positionals[2];
            if (!cbId) {
              console.error('Usage: archon codebase delete <id|name> [--force]');
              return 1;
            }
            await codebaseDeleteCommand(cbId, values.force as boolean | undefined, serverUrl);
            break;
          }

          case 'env': {
            const envAction = positionals[2];
            const cbId = positionals[3];
            if (envAction === 'list') {
              if (!cbId) {
                console.error('Usage: archon codebase env list <id|name> [--json]');
                return 1;
              }
              await codebaseEnvListCommand(cbId, jsonFlag);
            } else if (envAction === 'set') {
              const key = positionals[4];
              if (!cbId || !key || positionals.length < 6) {
                console.error('Usage: archon codebase env set <id|name> <key> <value>');
                return 1;
              }
              await codebaseEnvSetCommand(cbId, key, positionals.slice(5).join(' '), serverUrl);
            } else if (envAction === 'delete') {
              const key = positionals[4];
              if (!cbId || !key) {
                console.error('Usage: archon codebase env delete <id|name> <key>');
                return 1;
              }
              await codebaseEnvDeleteCommand(cbId, key, serverUrl);
            } else {
              console.error('Usage: archon codebase env <list|set|delete> <id|name> ...');
              return 1;
            }
            break;
          }

          case 'environments': {
            const cbId = positionals[2];
            if (!cbId) {
              console.error('Usage: archon codebase environments <id|name> [--json]');
              return 1;
            }
            await codebaseEnvironmentsCommand(cbId, jsonFlag);
            break;
          }

          default:
            if (subcommand === undefined) console.error('Missing codebase subcommand');
            else console.error(`Unknown codebase subcommand: ${subcommand}`);
            console.error('Available: list, get, register, delete, env, environments');
            return 1;
        }
        break;

      case 'conversation':
        switch (subcommand) {
          case 'list':
            await conversationListCommand({ limit: limitFlag, json: jsonFlag });
            break;

          case 'get': {
            const convId = positionals[2];
            if (!convId) {
              console.error('Usage: archon conversation get <id> [--json]');
              return 1;
            }
            await conversationGetCommand(convId, jsonFlag);
            break;
          }

          case 'messages': {
            const convId = positionals[2];
            if (!convId) {
              console.error('Usage: archon conversation messages <id> [--limit <n>] [--json]');
              return 1;
            }
            await conversationMessagesCommand(convId, { limit: limitFlag, json: jsonFlag });
            break;
          }

          case 'create':
            await conversationCreateCommand({ title: titleFlag, json: jsonFlag }, serverUrl);
            break;

          case 'title': {
            const convId = positionals[2];
            const newTitle = titleFlag ?? positionals.slice(3).join(' ');
            if (!convId || !newTitle) {
              console.error('Usage: archon conversation title <id> <title>');
              return 1;
            }
            await conversationTitleCommand(convId, newTitle, serverUrl);
            break;
          }

          case 'delete': {
            const convId = positionals[2];
            if (!convId) {
              console.error('Usage: archon conversation delete <id> [--force]');
              return 1;
            }
            await conversationDeleteCommand(convId, values.force as boolean | undefined, serverUrl);
            break;
          }

          default:
            if (subcommand === undefined) console.error('Missing conversation subcommand');
            else console.error(`Unknown conversation subcommand: ${subcommand}`);
            console.error('Available: list, get, messages, create, title, delete');
            return 1;
        }
        break;

      case 'providers':
        switch (subcommand) {
          case 'list':
            providersListCommand(jsonFlag);
            break;

          default:
            if (subcommand === undefined) console.error('Missing providers subcommand');
            else console.error(`Unknown providers subcommand: ${subcommand}`);
            console.error('Available: list');
            return 1;
        }
        break;

      case 'config':
        switch (subcommand) {
          case 'show':
            await configShowCommand(cwd, jsonFlag);
            break;

          case 'assistant': {
            const provider = positionals[2];
            if (!provider) {
              console.error(
                'Usage: archon config assistant <provider> [--model <m>] [--setting-sources <a,b>] [--json]'
              );
              return 1;
            }
            await configAssistantCommand(
              provider,
              { model: modelFlag, settingSources: settingSourcesFlag, json: jsonFlag, cwd },
              serverUrl
            );
            break;
          }

          case 'path':
            configPathCommand(jsonFlag);
            break;

          default:
            if (subcommand === undefined) console.error('Missing config subcommand');
            else console.error(`Unknown config subcommand: ${subcommand}`);
            console.error('Available: show, assistant, path');
            return 1;
        }
        break;

      case 'health':
        return await healthCommand(jsonFlag, serverUrl);

      case 'update-check':
        await updateCheckCommand(jsonFlag);
        break;

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

// Run main and exit with the returned code
main()
  .then(exitCode => {
    process.exit(exitCode);
  })
  .catch((error: unknown) => {
    const err = error as Error;
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
