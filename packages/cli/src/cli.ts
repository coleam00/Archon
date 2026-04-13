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
import { parseArgs } from 'util';
import { config } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';

// Load ~/.archon/.env with override: true — Archon-specific config must win
// over shell-inherited env vars (e.g. PORT, LOG_LEVEL from shell profile).
// CWD .env keys are already gone (stripCwdEnv above), so override only
// affects shell-inherited values, which is the intended behavior.
const globalEnvPath = resolve(process.env.HOME ?? '~', '.archon', '.env');
if (existsSync(globalEnvPath)) {
  const result = config({ path: globalEnvPath, override: true });
  if (result.error) {
    // Logger may not be available yet (early startup), so use console for user-facing error
    console.error(`Error loading .env from ${globalEnvPath}: ${result.error.message}`);
    console.error('Hint: Check for syntax errors in your .env file.');
    process.exit(1);
  }
}

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
import { registerBuiltinProviders } from '@archon/providers';
registerBuiltinProviders();

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
  workflowEventEmitCommand,
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
import { validateWorkflowsCommand, validateCommandsCommand } from './commands/validate';
import { serveCommand } from './commands/serve';
import { closeDatabase } from '@archon/core';
import {
  setLogLevel,
  createLogger,
  checkForUpdate,
  BUNDLED_IS_BINARY,
  BUNDLED_VERSION,
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
  chat <message>             Send a message to the orchestrator
  setup                      Interactive setup wizard for credentials and config
  workflow list              List available workflows in current directory
  workflow run <name> [msg]  Run a workflow with optional message
  workflow status            Show status of running workflows
  isolation list             List all active worktrees/environments
  isolation cleanup [days]   Remove stale environments (default: 7 days)
  isolation cleanup --merged Remove environments with branches merged into main
  continue <branch> [msg]    Continue work on an existing worktree with prior context
  complete <branch> [...]    Complete branch lifecycle (remove worktree + branches)
  serve                      Start the web UI server (downloads web UI on first run)
  validate workflows [name]  Validate workflow definitions and their references
  validate commands [name]   Validate command files
  version                    Show version info
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
  --port <port>              Override server port for 'serve' (default: 3090)
  --download-only            Download web UI without starting the server

Examples:
  archon chat "What does the orchestrator do?"
  archon workflow list
  archon workflow run investigate-issue "Fix the login bug"
  archon workflow run plan --cwd /path/to/repo "Add dark mode"
  archon workflow run implement --branch feature-auth "Implement auth"
  archon workflow run quick-fix --no-worktree "Fix typo"
  archon continue fix/issue-42 --workflow archon-smart-pr-review "Review the changes"
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
async function main(): Promise<number> {
  const args = process.argv.slice(2);

  // Handle no arguments - show help and exit successfully
  if (args.length === 0) {
    printUsage();
    return 0;
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
  // Handle help flag
  if (values.help) {
    printUsage();
    return 0;
  }

  // Get command and subcommand
  const command = positionals[0];
  const subcommand = positionals[1];

  // Commands that don't require git repo validation
  const noGitCommands = ['version', 'help', 'setup', 'chat', 'continue', 'serve'];
  const requiresGitRepo = !noGitCommands.includes(command ?? '');

  try {
    // Set log level from flags (quiet > verbose > default)
    if (values.quiet) {
      setLogLevel('warn');
    } else if (values.verbose) {
      setLogLevel('debug');
    }

    // Note: orphaned run cleanup moved to `workflow cleanup` command only.
    // Running it on every CLI startup killed parallel workflow runs (all
    // 'running' status rows were marked failed by each new process).

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

      case 'chat': {
        const chatMessage = positionals.slice(1).join(' ');
        if (!chatMessage) {
          console.error('Usage: archon chat <message>');
          return 1;
        }
        await chatCommand(chatMessage);
        break;
      }

      case 'setup':
        await setupCommand({ spawn: spawnFlag, repoPath: cwd });
        break;

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

          default:
            if (subcommand === undefined) {
              console.error('Missing workflow subcommand');
            } else {
              console.error(`Unknown workflow subcommand: ${subcommand}`);
            }
            console.error(
              'Available: list, run, status, resume, abandon, approve, reject, cleanup, event'
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
