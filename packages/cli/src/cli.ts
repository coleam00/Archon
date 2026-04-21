#!/usr/bin/env bun
/**
 * HarneesLab CLI - Run AI workflows from the command line
 *
 * Usage:
 *   hlab workflow list              List available workflows
 *   hlab workflow run <name> [msg]  Run a workflow
 *   hlab version                    Show version info
 */
// Must be the very first import — strips Bun-auto-loaded CWD .env keys before
// any module reads process.env at init time (e.g. @harneeslab/paths/logger reads LOG_LEVEL).
import '@harneeslab/paths/strip-cwd-env-boot';
import { parseArgs } from 'util';
import { config } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';

// Load the HarneesLab global .env with override: true — product-specific config must win
// over shell-inherited env vars (e.g. PORT, LOG_LEVEL from shell profile).
// CWD .env keys are already gone (stripCwdEnv above), so override only
// affects shell-inherited values, which is the intended behavior.
const globalEnvPath = getGlobalEnvPath();
if (existsSync(globalEnvPath)) {
  const result = config({ path: globalEnvPath, override: true });
  if (result.error) {
    // Logger may not be available yet (early startup), so use console for user-facing error
    console.error(`.env 로드 실패 (${globalEnvPath}): ${result.error.message}`);
    console.error('힌트: .env 파일의 문법 오류를 확인하세요.');
    process.exit(1);
  }
}

function getGlobalEnvPath(): string {
  const harneeslabHome = process.env.HARNEESLAB_HOME;
  if (harneeslabHome) {
    return resolve(expandHomeEnv('HARNEESLAB_HOME', harneeslabHome), '.env');
  }

  const legacyArchonHome = process.env.ARCHON_HOME;
  if (legacyArchonHome) {
    return resolve(expandHomeEnv('ARCHON_HOME', legacyArchonHome), '.env');
  }

  return resolve(process.env.HOME ?? homedir(), '.archon', '.env');
}

function expandHomeEnv(name: string, value: string): string {
  if (value === 'undefined') {
    console.error(`${name}이(가) literal string "undefined"로 설정되어 있습니다.`);
    console.error(`${name}을(를) unset 하거나 유효한 path로 설정하세요.`);
    process.exit(1);
  }

  if (value.startsWith('~')) {
    return resolve(homedir(), value.slice(1).replace(/^[/\\]/, ''));
  }

  return value;
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
import { registerBuiltinProviders, registerCommunityProviders } from '@harneeslab/providers';
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
  workflowEventEmitCommand,
  isValidEventType,
} from './commands/workflow';
import { WORKFLOW_EVENT_TYPES } from '@harneeslab/workflows/store';
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
import { closeDatabase } from '@harneeslab/core';
import {
  setLogLevel,
  createLogger,
  checkForUpdate,
  BUNDLED_IS_BINARY,
  BUNDLED_VERSION,
  shutdownTelemetry,
} from '@harneeslab/paths';
import * as git from '@harneeslab/git';

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
HarneesLab CLI - 명령줄에서 AI workflow(워크플로)를 실행합니다

사용법:
  hlab <command> [subcommand] [options] [arguments]

명령:
  chat <message>             orchestrator에 메시지를 보냅니다
  setup                      자격 증명과 설정을 대화형으로 구성합니다
  workflow list              현재 디렉터리의 사용 가능한 workflow 목록을 표시합니다
  workflow run <name> [msg]  선택 메시지와 함께 workflow를 실행합니다
  workflow status            실행 중인 workflow 상태를 표시합니다
  isolation list             활성 작업공간/워크트리 목록을 표시합니다
  isolation cleanup [days]   오래된 작업공간을 삭제합니다 (기본값: 7일)
  isolation cleanup --merged main에 merge된 branch의 작업공간을 삭제합니다
  continue <branch> [msg]    기존 worktree에서 이전 context로 작업을 이어갑니다
  complete <branch> [...]    branch 수명주기를 완료합니다 (worktree + branch 삭제)
  serve                      web UI 서버를 시작합니다 (처음 실행 시 web UI 다운로드)
  validate workflows [name]  workflow 정의와 참조를 검증합니다
  validate commands [name]   command 파일을 검증합니다
  version                    버전 정보를 표시합니다
  help                       이 도움말을 표시합니다

옵션:
  --cwd <path>               작업 디렉터리를 지정합니다 (기본값: 현재 디렉터리)
  --branch, -b <name>        branch용 worktree를 만들거나 기존 worktree를 재사용합니다
  --from, --from-branch <name> 지정한 시작점에서 새 branch를 만듭니다
  --no-worktree              worktree 격리 없이 현재 branch에서 직접 실행합니다
  --resume                   가장 최근 실패한 workflow run을 재개합니다 (--branch와 함께 사용 불가)
  --spawn                    새 터미널 창에서 setup 마법사를 엽니다 (setup command용)
  --quiet, -q                경고와 오류만 출력합니다
  --verbose, -v              디버그 수준 출력을 표시합니다
  --json                     기계가 읽을 수 있는 JSON을 출력합니다 (workflow list용)
  --workflow <name>          'continue'에서 실행할 workflow (기본값: archon-assist)
  --no-context               'continue'에서 context 주입을 건너뜁니다
  --port <port>              'serve'의 서버 port를 지정합니다 (기본값: 3090)
  --download-only            서버를 시작하지 않고 web UI만 다운로드합니다

예시:
  hlab chat "What does the orchestrator do?"
  hlab workflow list
  hlab workflow run investigate-issue "Fix the login bug"
  hlab workflow run plan --cwd /path/to/repo "Add dark mode"
  hlab workflow run implement --branch feature-auth "Implement auth"
  hlab workflow run quick-fix --no-worktree "Fix typo"
  hlab continue fix/issue-42 --workflow archon-smart-pr-review "Review the changes"
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
        `업데이트 가능: v${result.currentVersion} → v${result.latestVersion} - ${result.releaseUrl}\n`
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
    console.error(`인수 파싱 오류: ${err.message}`);
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
        console.error(`오류: 디렉터리가 없습니다: ${cwd}`);
        return 1;
      }

      // Validate git repository and resolve to root
      const repoRoot = await git.findRepoRoot(cwd);
      if (!repoRoot) {
        console.error('오류: git repository 안에서 실행해야 합니다.');
        console.error('HarneesLab CLI는 git repository 내부에서 실행되어야 합니다.');
        console.error('git repo로 이동하거나 --cwd로 repo 경로를 지정하세요.');
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
          console.error('사용법: hlab chat <message>');
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
              console.error('사용법: hlab workflow run <name> [message]');
              return 1;
            }
            const userMessage = positionals.slice(3).join(' ') || '';
            if (branchName !== undefined && noWorktree) {
              console.error(
                '오류: --branch와 --no-worktree는 함께 사용할 수 없습니다.\n' +
                  '  --branch는 격리된 worktree를 만듭니다.\n' +
                  '  --no-worktree는 현재 repo에서 직접 실행합니다.\n' +
                  '둘 중 하나만 사용하세요.'
              );
              return 1;
            }
            if (noWorktree && fromBranch !== undefined) {
              console.error(
                '오류: --from/--from-branch는 --no-worktree와 함께 사용할 수 없습니다.\n' +
                  '--from을 제거하거나 --no-worktree를 빼세요.'
              );
              return 1;
            }
            if (resumeFlag && branchName !== undefined) {
              console.error(
                '오류: --resume과 --branch는 함께 사용할 수 없습니다.\n' +
                  '  --resume은 실패한 run의 기존 worktree를 재사용합니다.\n' +
                  '  --resume을 사용할 때는 --branch를 제거하세요.'
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
              console.error('사용법: hlab workflow resume <run-id>');
              return 1;
            }
            await workflowResumeCommand(resumeRunId);
            break;
          }

          case 'abandon': {
            const abandonRunId = positionals[2];
            if (!abandonRunId) {
              console.error('사용법: hlab workflow abandon <run-id>');
              return 1;
            }
            await workflowAbandonCommand(abandonRunId);
            break;
          }

          case 'approve': {
            const approveRunId = positionals[2];
            if (!approveRunId) {
              console.error('사용법: hlab workflow approve <run-id> [comment]');
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
              console.error('사용법: hlab workflow reject <run-id> [reason]');
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
              console.error('사용법: hlab workflow cleanup [days]');
              console.error('  days: N일보다 오래된 종료된 run을 삭제합니다 (기본값: 7)');
              return 1;
            }
            await workflowCleanupCommand(days);
            break;
          }

          case 'event': {
            const action = positionals[2];
            if (action !== 'emit') {
              if (action === undefined) {
                console.error('workflow event 하위 명령이 필요합니다.');
              } else {
                console.error(`알 수 없는 workflow event 하위 명령: ${action}`);
              }
              console.error('사용 가능: emit');
              return 1;
            }
            const runId = values['run-id'] as string | undefined;
            const eventType = values.type as string | undefined;
            if (!runId) {
              console.error('사용법: hlab workflow event emit --run-id <uuid> --type <event-type>');
              console.error('오류: --run-id가 필요합니다.');
              return 1;
            }
            if (!eventType) {
              console.error('사용법: hlab workflow event emit --run-id <uuid> --type <event-type>');
              console.error('오류: --type이 필요합니다.');
              return 1;
            }
            if (!isValidEventType(eventType)) {
              console.error(`오류: 알 수 없는 event type: ${eventType}`);
              console.error(`유효한 type: ${WORKFLOW_EVENT_TYPES.join(', ')}`);
              return 1;
            }
            let eventData: Record<string, unknown> | undefined;
            const rawData = values.data as string | undefined;
            if (rawData) {
              try {
                eventData = JSON.parse(rawData) as Record<string, unknown>;
              } catch {
                console.warn(
                  `경고: --data가 유효한 JSON이 아니어서 data payload 없이 event를 보냅니다: ${rawData}`
                );
              }
            }
            await workflowEventEmitCommand(runId, eventType, eventData);
            break;
          }

          default:
            if (subcommand === undefined) {
              console.error('workflow 하위 명령이 필요합니다.');
            } else {
              console.error(`알 수 없는 workflow 하위 명령: ${subcommand}`);
            }
            console.error(
              '사용 가능: list, run, status, resume, abandon, approve, reject, cleanup, event'
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
              console.error('isolation 하위 명령이 필요합니다.');
            } else {
              console.error(`알 수 없는 isolation 하위 명령: ${subcommand}`);
            }
            console.error('사용 가능: list, cleanup');
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
              console.error('validate 대상이 필요합니다.');
            } else {
              console.error(`알 수 없는 validate 대상: ${subcommand}`);
            }
            console.error('사용 가능: workflows, commands');
            return 1;
        }

      case 'complete': {
        const branches = positionals.slice(1);
        if (branches.length === 0) {
          console.error('사용법: hlab complete <branch-name> [branch2 ...]');
          return 1;
        }
        const forceFlag = args.includes('--force');
        await isolationCompleteCommand(branches, { force: forceFlag, deleteRemote: true });
        break;
      }

      case 'continue': {
        const continueBranch = positionals[1];
        if (!continueBranch) {
          console.error('사용법: hlab continue <branch> [--workflow <name>] "instruction"');
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
          console.error('명령이 필요합니다.');
        } else {
          console.error(`알 수 없는 명령: ${command}`);
        }
        printUsage();
        return 1;
    }
    await printUpdateNotice(values.quiet as boolean | undefined);
    return 0;
  } catch (error) {
    const err = error as Error;
    console.error(`오류: ${err.message}`);
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
    console.error('치명적 오류:', err.message);
    process.exit(1);
  });
