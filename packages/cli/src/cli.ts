#!/usr/bin/env bun
/**
 * Archon CLI - Run AI workflows from the command line
 *
 * Usage:
 *   archon workflow list [name]       List available workflows
 *   archon workflow run <name> [msg]  Run a workflow
 *   archon version                    Show version info
 */
// Must be the very first import — strips Bun-auto-loaded CWD .env keys before
// any module reads process.env at init time (e.g. @archon/paths/logger reads LOG_LEVEL).
import '@archon/paths/strip-cwd-env-boot';
// Capture explicit chat scope before loading Archon env or command modules.
import './workflow-scope';
// Load Archon env before command imports. loadCliEnv preserves inherited workflow
// identity and prevents repository env from redirecting the user's stored gh login.
import { loadCliEnv } from './load-cli-env';
import {
  captureDetachedInstallContext,
  restoreDetachedInstallContext,
  setLogDestination,
} from '@archon/paths';
// A command's stdout is its output (`archon … > file`, `| jq`, an agent reading
// it); logs are diagnostics. Set before anything below can log.
setLogDestination('stderr');
const hasDetachedRunConfigHandoff = process.argv
  .slice(2)
  .includes('--internal-detached-run-config');
const inheritedInstallContext = hasDetachedRunConfigHandoff
  ? captureDetachedInstallContext()
  : undefined;
const inheritedEnv = { ...process.env };
const forgeTrustedEnv = await loadCliEnv(process.cwd());
// The detached parent sealed this payload with its effective install key. Repo
// env still loads normally, but it cannot replace any input that derives the
// install home before the child consumes the accepted snapshot.
if (inheritedInstallContext) {
  restoreDetachedInstallContext(inheritedInstallContext);
}

// Install the pipe-safe `console.log` shim BEFORE any command module imports.
// `console.log` can reach fd 1 as a non-blocking pipe, and short writes are
// silently dropped against a slow reader. The shim delegates through
// `writeStdout` so the stream layer queues short writes and retries `EAGAIN`
// instead of dropping the tail — but delivery is fire-and-forget, so the
// patched `console.log` returns synchronously and the exit path below must
// await `flushPendingWrites()` before `process.exit()`. See
// `utils/exit-with-drain.ts` (the call site that owns the drain) and
// `utils/safe-console.ts` for the underlying shim, and #2400 for the full
// rationale.
import { installPipeSafeConsole } from './utils/safe-console';
import { withDrainedExit } from './utils/exit-with-drain';
import { writeJsonLine } from './utils/stdout';
import { escapeRunJobIfRequested } from './utils/run-job-escape';
import { rejectConfigOutsideRun, RESUME_RUN_CONFIG_CONFLICT } from './dispatch-guards';
import { resolveCliExitCode } from './utils/workflow-exit-code';
import type { WorkflowRunConfigInput } from '@archon/workflows/schemas/run-config';
installPipeSafeConsole();

import { parseArgs } from 'util';
import { cliArgOptions } from './args';
import { shouldReportCliStart } from './utils/cli-start-telemetry';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { type CliRouteContext, fail, getLog, printUsageFor } from './routes/context';
import {
  closeDb,
  markDatabaseRouteLoaded,
  registerProviders,
  usesDatabaseStore,
} from './routes/route-loader';
import * as routes from './routes/commands';
import * as workflowRoutes from './routes/workflow';
import { runWorkflowRun } from './routes/workflow-run';

// Smart defaults for Claude auth
// If no explicit tokens, default to global auth from `claude /login`
if (!process.env.CLAUDE_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  if (process.env.CLAUDE_USE_GLOBAL_AUTH === undefined) {
    process.env.CLAUDE_USE_GLOBAL_AUTH = 'true';
  }
}

import {
  setLogLevel,
  getLogLevel,
  checkForUpdate,
  takeCachedUpdateNotice,
  BUNDLED_IS_BINARY,
  BUNDLED_VERSION,
  shutdownTelemetry,
  captureArchonStarted,
  isVerboseBoot,
  refreshCompiledInstallManifest,
  canonicalizeProjectPath,
} from '@archon/paths';
import { publishArchonCliCommand } from '@archon/paths/cli-command';

publishArchonCliCommand();

function printUpdateNotice(): void {
  try {
    const result = takeCachedUpdateNotice(BUNDLED_VERSION);
    if (result) {
      process.stderr.write(
        `Update available: v${result.currentVersion} → v${result.latestVersion}\n` +
          'Homebrew: brew upgrade archon\n' +
          'Quick installer: re-run https://archon.diy/install (PowerShell: https://archon.diy/install.ps1)\n' +
          `Release notes: ${result.releaseUrl}\n` +
          'Updating Archon: https://archon.diy/getting-started/updating/\n'
      );
    }
  } catch (err) {
    getLog().debug({ err }, 'update_check.notice_failed');
  }
}

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

interface ParsedCliArgs {
  values: Record<string, unknown>;
  positionals: string[];
}

/**
 * Main CLI entry point
 * Returns exit code (0 = success, non-zero = failure)
 */
async function main(): Promise<number> {
  const args = process.argv.slice(2);

  // Anonymous startup event (self-gates on opt-out). Emitted before any early
  // return so every invocation — including bare `archon`, `--help`, and
  // `--version` — is counted once; `serve` and detached run owners are counted
  // by another process (see shouldReportCliStart). Each early-return path below
  // flushes via shutdownTelemetry(); the main command path flushes in its finally.
  if (shouldReportCliStart(args, process.env)) captureArchonStarted({ surface: 'cli' });

  if (args.length === 0) return await printIndexHelp();

  // Version flag aliases bypass option parsing and the git-repo check so
  // `archon --version` works the same as `archon version` from any directory.
  if (isVersionRequest(args)) return await runVersionRequest();

  const parsed = await parseCliArgs(args);
  if (typeof parsed === 'number') return parsed;
  return await runParsedCommand(parsed);
}

/** Bare `archon`: show the help index and exit successfully. */
async function printIndexHelp(): Promise<number> {
  refreshCompiledInstallManifest(BUNDLED_IS_BINARY, process.execPath, BUNDLED_VERSION);
  await printUsageFor();
  await shutdownTelemetry();
  return 0;
}

async function runVersionRequest(): Promise<number> {
  try {
    refreshCompiledInstallManifest(BUNDLED_IS_BINARY, process.execPath, BUNDLED_VERSION);
    const { versionCommand } = await import('./commands/version');
    await versionCommand();
    return 0;
  } finally {
    await shutdownTelemetry();
    await closeDb();
  }
}

/** Parses global options, or reports the rejection and returns its exit code. */
async function parseCliArgs(args: string[]): Promise<ParsedCliArgs | 1> {
  try {
    return parseArgs({
      args,
      options: cliArgOptions,
      allowPositionals: true,
      // Strict mode rejects unknown flags so a mistyped option (e.g. `--dry-run`)
      // errors here instead of being silently dropped before command validation.
      strict: true,
    });
  } catch (error) {
    const err = error as Error;
    // parseArgs rejected before values.json was bound, so derive the flag
    // from raw argv to honor the --json stdout contract.
    const json = args.includes('--json');
    if (json) setLogLevel('silent');
    refreshCompiledInstallManifest(BUNDLED_IS_BINARY, process.execPath, BUNDLED_VERSION);
    await fail(json, `Error parsing arguments: ${err.message}`);
    if (!json) await printUsageFor();
    await shutdownTelemetry();
    return 1;
  }
}

/**
 * Commands default to warn: info records are engine internals that bury the
 * command's own output, even on stderr. `serve` is the exception: its logs are
 * its output, so they stay at info on stdout, as when the server runs directly.
 * Lazy loggers pick up this level at first creation.
 */
function applyOutputPolicy(
  values: Record<string, unknown>,
  command: string | undefined,
  subcommand: string | undefined
): void {
  const isServe = command === 'serve';
  if (isServe) setLogDestination('stdout');
  const suppressByDefault = !isServe && !values.verbose && !isVerboseBoot();
  const rawTranscriptCommand = command === 'workflow' && subcommand === 'logs';
  if (values.json || rawTranscriptCommand) {
    setLogLevel('silent');
  } else if (values.quiet || suppressByDefault) {
    // Only ever quieter: an explicit LOG_LEVEL of error, fatal, or silent stays.
    if (['trace', 'debug', 'info'].includes(getLogLevel())) setLogLevel('warn');
  } else if (values.verbose) {
    setLogLevel('debug');
  }
}

/**
 * Runs one parsed invocation. This is the single owner of command error
 * mapping and of the cleanup every command path runs on its way out.
 */
async function runParsedCommand({ values, positionals }: ParsedCliArgs): Promise<number> {
  const command = positionals[0];
  const subcommand = positionals[1];
  const json = values.json as boolean | undefined;
  if (values['base-branch'] !== undefined && (command !== 'workflow' || subcommand !== 'run')) {
    await fail(
      values.json === true,
      '--base-branch is only supported by workflow run for initial project registration.'
    );
    await shutdownTelemetry();
    return 1;
  }
  // Apply output policy before install discovery: its best-effort debug logs
  // must never prefix a machine-readable response.
  applyOutputPolicy(values, command, subcommand);
  refreshCompiledInstallManifest(BUNDLED_IS_BINARY, process.execPath, BUNDLED_VERSION);

  // Handle help flag — route through the scoped renderer using the already-
  // parsed positionals so `archon <command> [--subcommand] --help` shows only
  // the matching slice instead of the full index.
  if (values.help) {
    await printUsageFor(command, subcommand);
    await shutdownTelemetry();
    return 0;
  }

  const showUpdateNotice =
    BUNDLED_IS_BINARY &&
    !values.quiet &&
    !json &&
    command === 'workflow' &&
    (subcommand === 'run' || subcommand === 'resume');
  if (showUpdateNotice) void checkForUpdate(BUNDLED_VERSION);

  const cwdValue = values.cwd;
  const cwd = resolve(typeof cwdValue === 'string' ? cwdValue : process.cwd());
  try {
    return await dispatchCommand({
      values,
      positionals,
      command,
      subcommand,
      cwd,
      effectiveCwd: cwd,
      json,
      detachedRunConfig: undefined,
      inheritedEnv,
      forgeTrustedEnv,
    });
  } catch (error) {
    return await reportCommandError(error as Error, json);
  } finally {
    if (showUpdateNotice) printUpdateNotice();
    // Flush queued telemetry events before the CLI process exits.
    // Short-lived CLI commands lose buffered events if shutdown() is skipped.
    await shutdownTelemetry();
    // Always close database connection
    await closeDb();
  }
}

async function reportCommandError(err: Error, json: boolean | undefined): Promise<number> {
  // A detached child reports its run's own failure with a reserved status so its
  // launcher can tell that apart from a child that died before the run started.
  const exitCode = resolveCliExitCode(err);
  if (json) {
    await writeJsonLine({ ok: false, error: err.message });
    return exitCode;
  }
  console.error(`Error: ${err.message}`);
  if (process.env.DEBUG) {
    console.error(err.stack);
  }
  return exitCode;
}

/** A file-store install must be configured validly before any workflow or trigger command runs. */
async function assertFileStoreIfNeeded({
  command,
  subcommand,
  positionals,
}: CliRouteContext): Promise<void> {
  // `workflow wake schedule` installs an OS timer and never opens the store or a provider.
  const wakeSchedule =
    command === 'workflow' && subcommand === 'wake' && positionals[2] === 'schedule';
  if (
    (command === 'workflow' || command === 'trigger') &&
    !wakeSchedule &&
    !(await usesDatabaseStore())
  ) {
    // Provider concurrency caps are validated against registered providers.
    await registerProviders();
    const { assertFileStoreConfiguration } = await import('@archon/core/config/store-selection');
    await assertFileStoreConfiguration();
  }
}

async function decodeDetachedRunConfig({
  command,
  subcommand,
  values,
}: CliRouteContext): Promise<WorkflowRunConfigInput | undefined> {
  const detachedRunConfigPayload = values['internal-detached-run-config'];
  if (
    command === 'workflow' &&
    subcommand === 'run' &&
    typeof detachedRunConfigPayload === 'string'
  ) {
    const { decodeWorkflowRunConfigHandoff } = await import(
      '@archon/core/config/run-config-handoff'
    );
    const detachedRunConfig = decodeWorkflowRunConfigHandoff(detachedRunConfigPayload);
    // Fail-fast for the decode step, not a second copy of the invariant: `workflow-run-admission.ts`
    // still owns this rejection for every caller. A legitimately spawned detached child
    // cannot reach it — the parent refuses to seal a config for a continuation before it
    // forks — so this only fires on a hand-built `--internal-detached-run-config`, and
    // saves it a database round-trip on the way to the same message.
    if (values.resume) throw new Error(RESUME_RUN_CONFIG_CONFLICT);
    return detachedRunConfig;
  }
  return undefined;
}

/** Routes the commands that run before the project gate, then gates and routes the rest. */
async function dispatchCommand(base: CliRouteContext): Promise<number> {
  const { command, subcommand, values } = base;
  await assertFileStoreIfNeeded(base);
  const ctx = { ...base, detachedRunConfig: await decodeDetachedRunConfig(base) };

  if (command === 'forge') return await routes.runForge(ctx);
  if (command === 'workflow' && (subcommand === 'wake' || subcommand === 'signal')) {
    return await workflowRoutes.runWorkflowContinuation(ctx, subcommand);
  }
  const configOutsideRun = rejectConfigOutsideRun(
    command,
    subcommand,
    values.config,
    values['config-from-run']
  );
  if (configOutsideRun) return await fail(ctx.json, configOutsideRun);
  if (command === 'continue') return await routes.runRemovedContinue(ctx);
  if (command === 'provider') return await routes.runProvider(ctx);
  if (command === 'plugin') return await routes.runPlugin(ctx);
  // Note: orphaned run cleanup moved to `workflow cleanup` command only.
  // Running it on every CLI startup killed parallel workflow runs (all
  // 'running' status rows were marked failed by each new process).

  if (command === 'workflow' && subcommand === 'test') {
    return await workflowRoutes.runWorkflowTest(ctx);
  }

  const effectiveCwd = await resolveEffectiveCwd(ctx);
  if (typeof effectiveCwd === 'number') return effectiveCwd;
  return await dispatchGatedCommand({ ...ctx, effectiveCwd });
}

// Commands that don't require git repo validation
const NO_GIT_COMMANDS = [
  'state',
  'trigger',
  'version',
  'help',
  'setup',
  'chat',
  'serve',
  'skill',
  'doctor',
  'telemetry',
  'auth',
  'user',
  'ai',
  'project',
];

function requiresGitRepo(command: string | undefined, subcommand: string | undefined): boolean {
  // `workflow attention` resolves its own scope: `--all`, `--project`, or the working
  // directory's project, which need not be registered or a git repository.
  return (
    !NO_GIT_COMMANDS.includes(command ?? '') &&
    !(command === 'workflow' && subcommand === 'attention')
  );
}

/** The project gate: the directory a command acts on, or the exit code of its refusal. */
async function resolveEffectiveCwd(ctx: CliRouteContext): Promise<string | number> {
  const { command, subcommand, values, cwd, json } = ctx;
  if (!requiresGitRepo(command, subcommand)) return cwd;
  if (!existsSync(cwd)) {
    return await fail(json, `Error: Directory does not exist: ${cwd}`);
  }

  const realCwd = await canonicalizeProjectPath(cwd);
  const isRun = command === 'workflow' && subcommand === 'run';
  if (isRun && values.folder) return realCwd;
  if (isRun && values['dry-run']) {
    const { resolveDiscoveryCwd } = await import('./utils/project-cwd');
    return await resolveDiscoveryCwd(realCwd);
  }
  return await resolveRegisteredCwd(ctx, realCwd);
}

async function resolveRegisteredCwd(
  ctx: CliRouteContext,
  realCwd: string
): Promise<string | number> {
  const databaseLookup = await usesDatabaseStore();
  try {
    if (databaseLookup) markDatabaseRouteLoaded();
    const { createCliWorkflowHost } = await import('./utils/workflow-host');
    const { resolveCodebaseForPath } = await import(
      '@archon/core/services/codebase-checkout-resolver'
    );
    const host = await createCliWorkflowHost();
    const { codebase, repoRoot } = await resolveCodebaseForPath(realCwd, host.records.codebases);
    if (!repoRoot && codebase?.kind !== 'folder') {
      return await fail(
        ctx.json,
        'Error: Not in a git repository.\n' +
          'Register this folder as a project: run with --folder, or use /register-project in chat.'
      );
    }
    return codebase?.kind === 'folder' ? codebase.default_cwd : (repoRoot ?? realCwd);
  } catch (error) {
    return await fallBackToRepoRoot(ctx, realCwd, error as Error);
  }
}

/** Workflow discovery still works in an unverifiable checkout when its git root is known. */
async function fallBackToRepoRoot(
  { command, subcommand, json }: CliRouteContext,
  realCwd: string,
  error: Error
): Promise<string | number> {
  if (command === 'validate' || (command === 'workflow' && subcommand === 'list')) {
    const { findRepoRoot } = await import('@archon/git');
    const repoRoot = await findRepoRoot(realCwd);
    if (repoRoot) return repoRoot;
  }
  return await fail(json, `Error: Could not verify project registration: ${error.message}`);
}

async function dispatchGatedCommand(ctx: CliRouteContext): Promise<number> {
  const { command, subcommand } = ctx;
  switch (command) {
    case 'state':
      return await routes.runState(ctx);
    case 'trigger':
      return await routes.runTrigger(ctx);
    case 'version':
      return await routes.runVersion();
    case 'help':
      return await routes.runHelp(ctx);
    case 'chat':
      return await routes.runChat(ctx);
    case 'setup':
      return await routes.runSetup(ctx);
    case 'workflow': {
      const route = await workflowRoutes.prepareWorkflowRoute(ctx);
      if (typeof route === 'number') return route;
      switch (subcommand) {
        case 'list':
          return await workflowRoutes.runWorkflowList(route);
        case 'run':
          return await runWorkflowRun(route);
        case 'status':
          return await workflowRoutes.runWorkflowStatus(route);
        case 'get':
          return await workflowRoutes.runWorkflowGet(route);
        case 'artifacts':
          return await workflowRoutes.runWorkflowArtifacts(route);
        case 'logs':
          return await workflowRoutes.runWorkflowLogs(route);
        case 'wait':
          return await workflowRoutes.runWorkflowWait(route);
        case 'runs':
          return await workflowRoutes.runWorkflowRuns(route);
        case 'resume':
          return await workflowRoutes.runWorkflowResume(route);
        case 'abandon':
          return await workflowRoutes.runWorkflowAbandon(route);
        case 'end-turn':
          return await workflowRoutes.runWorkflowEndTurn(route);
        case 'cancel':
          return await workflowRoutes.runWorkflowCancel(route);
        case 'approve':
          return await workflowRoutes.runWorkflowApprove(route);
        case 'reject':
          return await workflowRoutes.runWorkflowReject(route);
        case 'respond':
          return await workflowRoutes.runWorkflowRespond(route);
        case 'answer':
          return await workflowRoutes.runWorkflowAnswer(route);
        case 'attention':
          return await workflowRoutes.runWorkflowAttention(route);
        case 'cleanup':
          return await workflowRoutes.runWorkflowCleanup(route);
        case 'reset-sessions':
          return await workflowRoutes.runWorkflowResetSessions(route);
        case 'event':
          return await workflowRoutes.runWorkflowEvent(route);
        default:
          return await workflowRoutes.runUnknownWorkflowSubcommand(route);
      }
    }
    case 'project':
      return await routes.runProject(ctx);
    case 'user':
      return await routes.runUser(ctx);
    case 'isolation':
      return await routes.runIsolation(ctx);
    case 'validate':
      return await routes.runValidate(ctx);
    case 'complete':
      return await routes.runComplete(ctx);
    case 'serve':
      return await routes.runServe(ctx);
    case 'doctor':
      return await routes.runDoctor();
    case 'auth':
      return await routes.runAuth(ctx);
    case 'ai':
      return await routes.runAi(ctx);
    case 'telemetry':
      return await routes.runTelemetry(ctx);
    case 'skill':
      return await routes.runSkill(ctx);
    default:
      return await routes.runUnknownCommand(ctx);
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
await escapeRunJobIfRequested(process.argv.slice(2), inheritedEnv);
withDrainedExit(main);
