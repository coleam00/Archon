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
// Then load archon-owned env from ~/.archon/.env (user scope) and
// <cwd>/.archon/.env (repo scope, wins over user). Both with override: true.
// See packages/paths/src/env-loader.ts and the three-path model (#1302 / #1303).
import { loadArchonEnv } from '@archon/paths/env-loader';
import { captureDetachedInstallContext, restoreDetachedInstallContext } from '@archon/paths';
const hasDetachedRunConfigHandoff = process.argv
  .slice(2)
  .includes('--internal-detached-run-config');
const inheritedInstallContext = hasDetachedRunConfigHandoff
  ? captureDetachedInstallContext()
  : undefined;
loadArchonEnv(process.cwd());
// The detached parent sealed this payload with its effective install key. Repo
// env still loads normally, but it cannot replace any input that derives the
// install home before the child consumes the accepted snapshot.
if (inheritedInstallContext) {
  restoreDetachedInstallContext(inheritedInstallContext);
}

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
import { writeJsonLine } from './utils/stdout';
import {
  rejectConfigOnContinue,
  rejectConfigOutsideRun,
  rejectModelOnContinue,
  isContinueSubcommand,
  RESUME_RUN_CONFIG_CONFLICT,
} from './dispatch-guards';
import { resolveCliExitCode } from './utils/workflow-exit-code';
import type { WorkflowRunConfigInput } from '@archon/workflows/schemas/run-config';
installPipeSafeConsole();

import { parseArgs } from 'util';
import { cliArgOptions } from './args';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { stat } from 'fs/promises';

// Smart defaults for Claude auth
// If no explicit tokens, default to global auth from `claude /login`
if (!process.env.CLAUDE_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  if (process.env.CLAUDE_USE_GLOBAL_AUTH === undefined) {
    process.env.CLAUDE_USE_GLOBAL_AUTH = 'true';
  }
}

import {
  setLogLevel,
  createLogger,
  checkForUpdate,
  BUNDLED_IS_BINARY,
  BUNDLED_VERSION,
  shutdownTelemetry,
  captureArchonStarted,
  isVerboseBoot,
  refreshCompiledInstallManifest,
  canonicalizeProjectPath,
} from '@archon/paths';

let providersRegistered = false;
let databaseRouteLoaded = false;

async function registerProviders(): Promise<void> {
  if (providersRegistered) return;
  const { registerBuiltinProviders, registerCommunityProviders } =
    await import('@archon/providers');
  registerBuiltinProviders();
  registerCommunityProviders();
  providersRegistered = true;
}

async function loadRoute<T>(
  loader: () => Promise<T>,
  options: { providers?: boolean; database?: boolean } = {}
): Promise<T> {
  if (options.providers) await registerProviders();
  const route = await loader();
  if (options.database) databaseRouteLoaded = true;
  return route;
}

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
 * Emit a failure message and return exit code 1. Under `--json` stdout must
 * stay exactly one machine-readable payload, so the diagnostic goes into an
 * `{ ok: false }` envelope there instead of bare stderr text (or stdout usage).
 */
async function fail(json: boolean | undefined, message: string): Promise<1> {
  if (json) {
    await writeJsonLine({ ok: false, error: message });
  } else {
    console.error(message);
  }
  return 1;
}

/**
 * Help rendering — structured data plus a renderer. The data is split into
 * three tables so the global help output stays byte-identical to the
 * pre-refactor template literal (the original Commands block, Options block,
 * and Examples block are each hand-curated and do not follow a natural entry
 * iteration order).
 *
 * `commandHelp` lists one entry per Commands-block line in the order they
 * appear. `orderedFlags` lists every flag in the pre-refactor Options block
 * order, with `owners` naming each flag's (command, subcommand) tuples; an
 * empty `owners` array marks the flag as global (only in `archon --help`).
 * `orderedExamples` lists every example in the pre-refactor Examples block
 * order with the same owner model. `printUsageFor(...)` selects entries and
 * filters the flag and example lists by owner for scoped slices.
 */

interface FlagOwner {
  command: string;
  subcommand?: string;
}

interface FlagHelp {
  spec: string;
  description: string;
  // Each (command, subcommand?) tuple that owns this flag. Empty means
  // "global": appears in `archon --help` only, never in any scoped slice.
  owners: FlagOwner[];
}

interface ExampleHelp {
  text: string;
  // The (command, subcommand?) tuple this example belongs to. An example
  // appears in `archon --help` iff its owner is selected.
  owner: FlagOwner;
}

// A scoped-only flag has no `owners` — the owning entry is implicit (the
// entry it hangs off). It appears only when that entry's slice renders.
interface ScopedFlagHelp {
  spec: string;
  description: string;
}

interface HelpEntry {
  command: string;
  subcommand?: string;
  spec: string;
  // Use `\n` to force a continuation line; each continuation aligns to
  // column 29. The renderer wraps to the next line when the spec itself
  // overflows the description column (spec.length > 35).
  description: string;
  // Scoped-only flags: shown in the matching `archon <cmd> [<subcmd>] --help`
  // slice but NOT in the global help. Used for flags the legacy template
  // literal documented via a Commands-block alias (e.g. `isolation cleanup
  // --merged`) rather than as a standalone Options entry, so the global
  // Options block stays byte-identical to the pre-refactor text while
  // scoped help can still surface every flag the entry actually accepts.
  scopedFlags?: ScopedFlagHelp[];
}

// One entry per Commands-block line, in global-help order. `printUsage()`
// delegates to `printUsageFor()` with no selection; `printUsageFor(...)`
// filters this list by the (command, subcommand) tuple for scoped slices.
// Subcommands listed in `scopedOnlyHelp` below never render in the global
// Commands block, so global help stays byte-identical to the pre-refactor
// template literal while scoped slices can still surface every supported
// subcommand (`--detach` is owned by `workflow approve`/`reject`, which
// live here so the global Commands block does not grow).
const commandHelp: HelpEntry[] = [
  { command: 'chat', spec: 'chat <message>', description: 'Send a message to the orchestrator' },
  {
    command: 'setup',
    spec: 'setup',
    description: 'Interactive setup wizard for credentials and config',
  },
  {
    command: 'workflow',
    subcommand: 'list',
    spec: 'workflow list [name] [--full] [--json]',
    description: 'List compact workflow descriptions\nUse <name> --full for one exact description',
    scopedFlags: [
      {
        spec: '--full',
        description:
          'When given with a name, show the exact description instead of the compact preview',
      },
    ],
  },
  {
    command: 'workflow',
    subcommand: 'run',
    spec: 'workflow run <name> [msg]',
    description: 'Run a workflow with optional message',
  },
  {
    command: 'workflow',
    subcommand: 'status',
    spec: 'workflow status',
    description: 'Show running/paused workflows for this project',
  },
  {
    command: 'workflow',
    subcommand: 'runs',
    spec: 'workflow runs',
    description: 'List recent runs (all statuses) for this project',
  },
  {
    command: 'workflow',
    subcommand: 'get',
    spec: 'workflow get <run-id>',
    description: 'Show detail for a single run (any status)',
  },
  {
    command: 'workflow',
    subcommand: 'logs',
    spec: 'workflow logs <run-id>',
    description: "Print or follow a run's JSONL transcript",
  },
  {
    command: 'workflow',
    subcommand: 'wait',
    spec: 'workflow wait <run-id>',
    description: 'Block until the run ends or needs a human decision',
  },
  {
    command: 'workflow',
    subcommand: 'resume',
    spec: 'workflow resume <run-id>',
    description: 'Resume a failed or paused run from completed nodes',
  },
  {
    command: 'workflow',
    subcommand: 'cancel',
    spec: 'workflow cancel <run-id>',
    description: 'Stop a running workflow started with --detach',
  },
  {
    command: 'workflow',
    subcommand: 'abandon',
    spec: 'workflow abandon <run-id>',
    description: 'Mark a run cancelled without stopping host work',
  },
  {
    command: 'workflow',
    subcommand: 'respond',
    spec: 'workflow respond <run-id> <decision> [text]',
    description:
      "Resolve a paused gate with any of its declared decisions\n('approve'/'reject' are sugar for the dedicated commands)",
  },
  {
    command: 'workflow',
    subcommand: 'search',
    spec: 'workflow search [query]',
    description: 'Search the workflow marketplace',
  },
  {
    command: 'workflow',
    subcommand: 'install',
    spec: 'workflow install <slug>',
    description: 'Install a workflow from the marketplace',
  },
  {
    command: 'workflow',
    subcommand: 'test',
    spec: 'workflow test [<name>|<folder>|<path>]',
    description:
      'Run declared dry-run fixtures (fixtures/*.stubs.yaml) for a\nworkflow, a workflow folder or pack (by name or directory\npath); relative paths resolve from the invoking directory before the\nrepository root. With no target, runs every fixture. Never creates a\nrun or contacts a provider; exec-code fixtures execute in a\nscratch worktree of HEAD',
  },
  {
    command: 'isolation',
    subcommand: 'list',
    spec: 'isolation list',
    description: 'List all active worktrees/environments',
  },
  {
    command: 'isolation',
    subcommand: 'cleanup',
    spec: 'isolation cleanup [days]',
    description: 'Remove stale environments (default: 7 days)',
  },
  {
    command: 'isolation',
    subcommand: 'cleanup',
    spec: 'isolation cleanup --merged',
    description: 'Remove environments with branches merged into main',
    // `--merged` and `--include-closed` are documented via the Commands-block
    // alias above in the legacy template literal; they live here so scoped
    // `isolation cleanup --help` can list them without changing the global
    // Options block.
    scopedFlags: [
      { spec: '--merged', description: 'Remove environments with branches merged into main' },
      {
        spec: '--include-closed',
        description: 'Also remove environments whose PRs were closed without merging',
      },
    ],
  },
  {
    command: 'complete',
    spec: 'complete <branch> [...]',
    description: 'Complete branch lifecycle (remove worktree + branches)',
  },
  {
    command: 'serve',
    spec: 'serve',
    description: 'Start the web UI server (downloads web UI on first run)',
  },
  {
    command: 'skill',
    subcommand: 'install',
    spec: 'skill install [path]',
    description: 'Install archon-cli into .claude/skills and .agents/skills',
  },
  {
    command: 'doctor',
    spec: 'doctor [--full]',
    description:
      'Verify your Archon setup (Claude/Codex binaries, gh auth, DB, adapters; --full also probes the OpenCode runtime SDK)',
  },
  {
    command: 'auth',
    subcommand: 'github',
    spec: 'auth github',
    description: 'Connect your GitHub identity via device flow (multi-user installs)',
  },
  {
    command: 'conversations',
    subcommand: 'list',
    spec: 'conversations list --unowned [--platform web|cli] [--limit <n>]',
    description: 'List conversations no Archon user owns (what a claim would take)',
    scopedFlags: [
      { spec: '--unowned', description: 'Required: the rows no Archon user owns' },
      {
        spec: '--platform <web|cli>',
        description: 'Narrow to one operator surface (default: both)',
      },
      {
        spec: '--limit <n>',
        description: 'Rows to print (default 20); the total is always reported',
      },
    ],
  },
  {
    command: 'conversations',
    subcommand: 'claim',
    spec: 'conversations claim --user <archon-user-id> [--platform web|cli] [--before <iso>] [--dry-run] [--yes]',
    description:
      'Attach unowned conversations and runs to one user after turning web auth on\nShell-only on purpose: an unowned row has no owner to authenticate against',
    scopedFlags: [
      {
        spec: '--user <archon-user-id>',
        description: 'Required: the remote_agent_users id rows are claimed for',
      },
      {
        spec: '--platform <web|cli>',
        description: 'Narrow to one operator surface (default: both)',
      },
      {
        spec: '--before <iso>',
        description: "Only rows older than this date, by the database's clock",
      },
      { spec: '--dry-run', description: 'Report both counts and write nothing' },
      {
        spec: '--yes',
        description: 'Apply; without it the command reports the counts and refuses',
      },
    ],
  },
  {
    command: 'ai',
    subcommand: 'key',
    spec: 'ai key set <provider>',
    description: 'Connect an AI provider API key (multi-user installs; key read from prompt/stdin)',
  },
  {
    command: 'ai',
    subcommand: 'login',
    spec: 'ai login <provider>',
    description: 'Connect a Claude, ChatGPT/Codex, or Copilot subscription',
  },
  {
    command: 'ai',
    subcommand: 'list',
    spec: 'ai list',
    description: 'List your connected AI provider keys',
  },
  {
    command: 'ai',
    subcommand: 'logout',
    spec: 'ai logout <provider>',
    description: 'Disconnect an AI provider key',
  },
  {
    command: 'ai',
    subcommand: 'tier',
    spec: 'ai tier set <t> <p> <m>',
    description:
      'Set a model tier (small/medium/large) → provider/model [--effort <e>] [--scope user|install]',
  },
  {
    command: 'ai',
    subcommand: 'tier',
    spec: 'ai tier list [--json]',
    description: 'Show configured tiers (install + yours) vs built-in defaults',
  },
  {
    command: 'ai',
    subcommand: 'tier',
    spec: 'ai tier unset <tier>',
    description: 'Unset a tier override (built-ins: claude/codex only) [--scope user|install]',
  },
  {
    command: 'ai',
    subcommand: 'alias',
    spec: 'ai alias set <@n> <p> <m>',
    description: 'Set a @custom model alias [--effort <e>] [--scope user|install]',
  },
  {
    command: 'ai',
    subcommand: 'alias',
    spec: 'ai alias list [--json]',
    description: 'Show configured @custom aliases (install + yours)',
  },
  {
    command: 'ai',
    subcommand: 'alias',
    spec: 'ai alias unset <@name>',
    description: 'Remove a @custom alias [--scope user|install]',
  },
  {
    command: 'ai',
    subcommand: 'default',
    spec: 'ai default <p> [<model>]',
    description: 'Set the default assistant (+ chat model) [--scope user|install]',
  },
  {
    command: 'telemetry',
    subcommand: 'status',
    spec: 'telemetry status',
    description: 'Show anonymous telemetry state (enabled, reason, ID, host)',
  },
  {
    command: 'telemetry',
    subcommand: 'reset',
    spec: 'telemetry reset',
    description: 'Rotate the anonymous install UUID',
  },
  {
    command: 'validate',
    subcommand: 'workflows',
    spec: 'validate workflows [name]',
    description: 'Validate workflow definitions and their references',
  },
  {
    command: 'validate',
    subcommand: 'commands',
    spec: 'validate commands [name]',
    description: 'Validate command files',
  },
  {
    command: 'version',
    spec: 'version, --version, -V',
    description: 'Show version info (also -v when used alone)',
  },
  { command: 'help', spec: 'help', description: 'Show this help message' },
];

// Scoped-only entries: subcommands the dispatch handles but whose Commands
// line never appeared in the pre-refactor monolithic help. They render only
// in their matching `archon <command> <subcommand> --help` slice; `archon
// --help` must stay byte-identical, so they are NOT concatenated into the
// global Commands block. Keeping them in a separate table (rather than
// appending to `commandHelp`) makes that boundary explicit and keeps the
// "no flag documentation is lost" invariant honest — nothing here ships in
// global help that was not in the original.
const scopedOnlyHelp: HelpEntry[] = [
  {
    command: 'workflow',
    subcommand: 'approve',
    spec: 'workflow approve <run-id>',
    description: 'Approve a paused gate (sugar for workflow respond <run-id> approve)',
    scopedFlags: [
      {
        spec: '--comment <text>',
        description:
          'Comment to attach to the approval (also accepted as positional args after <run-id>)',
      },
    ],
  },
  {
    command: 'workflow',
    subcommand: 'reject',
    spec: 'workflow reject <run-id>',
    description: 'Reject a paused gate (sugar for workflow respond <run-id> reject)',
    scopedFlags: [
      {
        spec: '--reason <text>',
        description:
          'Reason to record with the rejection (also accepted as positional args after <run-id>)',
      },
    ],
  },
  {
    command: 'workflow',
    subcommand: 'cleanup',
    spec: 'workflow cleanup [days]',
    description: 'Delete terminal runs older than N days (default: 7)',
  },
  {
    command: 'workflow',
    subcommand: 'reset-sessions',
    spec: 'workflow reset-sessions <workflow-name>',
    description:
      'Delete persisted sessions for a workflow (omits --scope only with --yes; [--node <id>] [--json])',
    scopedFlags: [
      {
        spec: '--scope <key>',
        description: 'Limit the reset to one scope (omit to delete every scope; requires --yes)',
      },
      {
        spec: '--node <id>',
        description: 'Limit the reset to one node within the chosen scope',
      },
      {
        spec: '--yes',
        description: 'Skip the confirmation prompt (required for cross-scope deletion)',
      },
    ],
  },
  {
    command: 'workflow',
    subcommand: 'event',
    spec: 'workflow event emit',
    description: 'Emit a workflow event into a run',
    scopedFlags: [
      { spec: '--run-id <id>', description: 'Target run for the event (required)' },
      { spec: '--type <event-type>', description: 'Event type to emit (required)' },
      { spec: '--data <json>', description: 'JSON payload for the event (optional)' },
    ],
  },
];

// Hand-curated flag order matching the pre-refactor Options block. Each flag
// lists its owning (command, subcommand?) tuples; an empty array means
// "global" — in `archon --help` only, never in a scoped slice. Multi-owner
// flags (e.g. `--detach`, `--events`, `--force`) deduplicate by spec within
// each render.
const orderedFlags: FlagHelp[] = [
  {
    spec: '--cwd <path>',
    description: 'Override working directory (default: current directory)',
    owners: [],
  },
  {
    spec: '--branch, -b <name>',
    description: 'Create worktree for branch (or reuse existing)',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--from, --from-branch <name>',
    description: 'Create new branch from specific start point',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--base <branch>',
    description: 'Per-dispatch base override for epic slices (worktree cut-from + PR target)',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--workflow-source <path>',
    description:
      'Read the workflow, its commands and scripts from this directory\ninstead of --cwd (which stays the workspace the run acts on)',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--no-worktree',
    description: 'Run on branch directly without worktree isolation',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--folder',
    description: 'Register the current non-git directory as a folder project and run in place',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--input <name>=<value>',
    description:
      'Supply a declared workflow input; repeat per input (mutually exclusive with --resume)',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--model <name>=<spec>',
    description: 'Rebind small/medium/large or @alias for one run; repeat per binding',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--config <path>',
    description: 'Load a sparse YAML config layer for one fresh workflow run',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--resume',
    description:
      'Resume the most recent failed or paused run of the workflow (mutually exclusive with --branch)',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--adopt <run-id>',
    description:
      "Start a new run adopting a terminal run's worktree/branch + artifacts ($ADOPTED_RUN_DIR)",
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--supersedes <run-id>',
    description:
      "Record this fresh run as replacing the prior run's open item (no lane inheritance)",
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--dry-run',
    description:
      'Simulate workflow DAG control flow without creating a run or contacting a provider',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--stubs <path>',
    description: 'YAML node-output map for --dry-run',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--stubs-init <path>',
    description: 'Write a complete dry-run stub scaffold and exit',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--default-stubs',
    description: 'Fill missing reached nodes with validated placeholders during --dry-run',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--exec-code',
    description: 'Execute trusted bash/script nodes during --dry-run (default: require stubs)',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--pause-at-gates',
    description: 'Stop a dry-run at approval gates instead of auto-approving',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--spawn',
    description: 'Open setup wizard in a new terminal window (for setup command)',
    owners: [{ command: 'setup' }],
  },
  {
    spec: '--quiet, -q',
    description: 'Reduce log verbosity to warnings and errors only',
    owners: [],
  },
  { spec: '--verbose, -v', description: 'Show debug-level output', owners: [] },
  {
    spec: '--json',
    description:
      'Output machine-readable JSON (list/status/get/wait/runs/approve/reject/respond/cancel/abandon/resume)',
    owners: [],
  },
  {
    spec: '--events',
    description: 'For verbose JSON status/get: output raw event rows instead of node summaries',
    owners: [
      { command: 'workflow', subcommand: 'status' },
      { command: 'workflow', subcommand: 'get' },
    ],
  },
  {
    spec: '--detach',
    description:
      "Run 'workflow run'/'approve'/'reject'/'respond'/'resume' in a detached background child (returns immediately)",
    owners: [
      { command: 'workflow', subcommand: 'run' },
      { command: 'workflow', subcommand: 'approve' },
      { command: 'workflow', subcommand: 'reject' },
      { command: 'workflow', subcommand: 'respond' },
      { command: 'workflow', subcommand: 'resume' },
    ],
  },
  {
    spec: '--all',
    description: "For 'workflow status/runs': list across all projects (ignore cwd scope)",
    owners: [
      { command: 'workflow', subcommand: 'status' },
      { command: 'workflow', subcommand: 'runs' },
    ],
  },
  {
    spec: '--status <status>',
    description: "For 'workflow runs': filter to one status (running, completed, failed, ...)",
    owners: [{ command: 'workflow', subcommand: 'runs' }],
  },
  {
    spec: '--open',
    description:
      "For 'workflow runs': the open-work inbox — failed runs nothing has adopted or superseded",
    owners: [{ command: 'workflow', subcommand: 'runs' }],
  },
  {
    spec: '--limit <n>',
    description: "For 'workflow runs': max rows (default 20)",
    owners: [{ command: 'workflow', subcommand: 'runs' }],
  },
  {
    spec: '--timeout <seconds>',
    description: "For 'workflow wait': give up after N seconds (default: wait indefinitely)",
    owners: [{ command: 'workflow', subcommand: 'wait' }],
  },
  {
    spec: '--follow',
    description: "For 'workflow logs': stream appended rows until the run ends",
    owners: [{ command: 'workflow', subcommand: 'logs' }],
  },
  {
    spec: '--conversation-id <id>',
    description:
      'Reuse a stable conversation scope across runs (enables\npersist_session resume between separate CLI invocations)',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--port <port>',
    description: "Override server port for 'serve' (default: 3090)",
    owners: [{ command: 'serve' }],
  },
  {
    spec: '--download-only',
    description: 'Download web UI without starting the server',
    owners: [{ command: 'serve' }],
  },
  {
    spec: '--force',
    description: 'Overwrite existing file (for workflow install)',
    owners: [{ command: 'workflow', subcommand: 'install' }],
  },
];

// Hand-curated example order matching the pre-refactor Examples block. The
// original order is not a natural entry iteration — e.g. workflow run's
// `--adopt` example appears after workflow runs's `--open` example — so we
// keep the exact order here and filter by owner for scoped rendering.
const orderedExamples: ExampleHelp[] = [
  { text: 'archon chat "What does the orchestrator do?"', owner: { command: 'chat' } },
  { text: 'archon workflow list', owner: { command: 'workflow', subcommand: 'list' } },
  {
    text: 'archon workflow run investigate-issue "Fix the login bug"',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  {
    text: 'archon workflow run plan --cwd /path/to/repo "Add dark mode"',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  {
    text: 'archon workflow run implement --branch feature-auth "Implement auth"',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  {
    text: 'archon workflow run quick-fix --no-worktree "Fix typo"',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  {
    text: 'archon workflow run assist --folder "List every repo under this multi-repo root"',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  {
    text: 'archon workflow run archon-assist --detach "Investigate the flaky test"',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  {
    text: 'archon workflow run assist --dry-run --stubs ./stubs.yaml --json',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  { text: 'archon workflow runs --json', owner: { command: 'workflow', subcommand: 'runs' } },
  {
    text: 'archon workflow get <run-id> --json',
    owner: { command: 'workflow', subcommand: 'get' },
  },
  {
    text: 'archon workflow logs <run-id> --follow',
    owner: { command: 'workflow', subcommand: 'logs' },
  },
  {
    text: 'archon workflow wait <run-id> --json',
    owner: { command: 'workflow', subcommand: 'wait' },
  },
  { text: 'archon workflow resume <run-id>', owner: { command: 'workflow', subcommand: 'resume' } },
  { text: 'archon workflow cancel <run-id>', owner: { command: 'workflow', subcommand: 'cancel' } },
  { text: 'archon workflow runs --open', owner: { command: 'workflow', subcommand: 'runs' } },
  {
    text: 'archon workflow run archon-smart-pr-review --adopt <run-id> "Review the changes"',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  { text: 'archon skill install', owner: { command: 'skill', subcommand: 'install' } },
  {
    text: 'archon skill install /path/to/project',
    owner: { command: 'skill', subcommand: 'install' },
  },
  {
    text: 'archon workflow search "pr review"',
    owner: { command: 'workflow', subcommand: 'search' },
  },
  {
    text: 'archon workflow install archon-piv-loop',
    owner: { command: 'workflow', subcommand: 'install' },
  },
];

// Description column in the Commands/Options block. Each line aligns its
// description to this column. Existing entries sit at spec.length <= 35
// (one space separator when padding has no room) or wrap to the next line
// when the spec itself overflows.
const HELP_DESC_COLUMN = 29;
const HELP_SPEC_WRAP_THRESHOLD = 35;

function formatSpecLine(spec: string, description: string): string {
  const parts = description.split('\n');
  const first = parts[0] ?? '';
  const rest = parts.slice(1);
  let firstLine: string;
  if (spec.length > HELP_SPEC_WRAP_THRESHOLD) {
    // Spec overflows the column: description goes on its own line at col 29.
    firstLine = `  ${spec}\n${' '.repeat(HELP_DESC_COLUMN)}${first}`;
  } else if (spec.length + 2 <= HELP_DESC_COLUMN) {
    // Pad spec so description lands at col 29.
    const pad = ' '.repeat(HELP_DESC_COLUMN - spec.length - 2);
    firstLine = `  ${spec}${pad}${first}`;
  } else {
    // Spec fills 28–35 chars: one space separator.
    firstLine = `  ${spec} ${first}`;
  }
  const continuations = rest.map(part => ' '.repeat(HELP_DESC_COLUMN) + part).join('\n');
  return continuations ? `${firstLine}\n${continuations}` : firstLine;
}

function ownerKey(owner: FlagOwner): string {
  return `${owner.command}|${owner.subcommand ?? ''}`;
}

function selectFlagsFor(selected: HelpEntry[], scopedOnly: ScopedFlagHelp[] = []): FlagHelp[] {
  const keys = new Set(selected.map(e => ownerKey(e)));
  const seen = new Set<string>();
  const out: FlagHelp[] = [];
  // Scoped-only flags come first so they appear at the top of the scoped
  // Options block; the matching entry's Commands alias already mentions them.
  for (const f of scopedOnly) {
    if (seen.has(f.spec)) continue;
    seen.add(f.spec);
    out.push({ ...f, owners: [] });
  }
  for (const f of orderedFlags) {
    if (!f.owners.some(o => keys.has(ownerKey(o)))) continue;
    if (seen.has(f.spec)) continue;
    seen.add(f.spec);
    out.push(f);
  }
  return out;
}

function selectExamplesFor(selected: HelpEntry[]): ExampleHelp[] {
  const keys = new Set(selected.map(e => ownerKey(e)));
  return orderedExamples.filter(ex => keys.has(ownerKey(ex.owner)));
}

function selectEntries(command: string | undefined, subcommand: string | undefined): HelpEntry[] {
  if (command === undefined) return commandHelp;
  // Scoped renders combine `commandHelp` matches with `scopedOnlyHelp`
  // matches. `scopedOnlyHelp` entries never render in the global Commands
  // block (the previous branch), so global help stays byte-identical while
  // every supported subcommand has a Commands line in its scoped slice.
  const sameCommand = commandHelp.filter(e => e.command === command);
  const scopedExtra = scopedOnlyHelp.filter(e => e.command === command);
  const merged = [...sameCommand, ...scopedExtra];
  if (subcommand === undefined) return merged;
  return merged.filter(e => e.subcommand === subcommand);
}

/**
 * Render the help slice for `command`/`subcommand`. With no arguments the
 * output is the global index, byte-identical to the pre-refactor template
 * literal. With a (command, subcommand) tuple, only that slice is shown.
 */
function printUsageFor(command?: string, subcommand?: string): void {
  const entries = selectEntries(command, subcommand);
  const sections: string[] = [];
  sections.push('Archon CLI - Run AI workflows from the command line');
  sections.push('');
  sections.push('Usage:');
  sections.push('  archon <command> [subcommand] [options] [arguments]');
  sections.push('');
  sections.push('Commands:');
  sections.push(entries.map(e => formatSpecLine(e.spec, e.description)).join('\n'));
  const flags =
    command === undefined
      ? orderedFlags
      : selectFlagsFor(
          entries,
          entries.flatMap(e => e.scopedFlags ?? [])
        );
  if (flags.length > 0) {
    sections.push('');
    sections.push('Options:');
    sections.push(flags.map(f => formatSpecLine(f.spec, f.description)).join('\n'));
  }
  const examples = command === undefined ? orderedExamples : selectExamplesFor(entries);
  if (examples.length > 0) {
    sections.push('');
    sections.push('Examples:');
    sections.push(examples.map(ex => `  ${ex.text}`).join('\n'));
  }
  console.log(`\n${sections.join('\n')}\n`);
}

/** Print the global usage information (every entry, every flag, every example). */
function printUsage(): void {
  printUsageFor();
}

/**
 * Safely close the database connection
 */
async function closeDb(): Promise<void> {
  if (!databaseRouteLoaded) return;
  try {
    const { closeDatabase } = await import('@archon/core/db/connection');
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
    refreshCompiledInstallManifest(BUNDLED_IS_BINARY, process.execPath, BUNDLED_VERSION);
    printUsage();
    await shutdownTelemetry();
    return 0;
  }

  // Version flag aliases bypass option parsing and the git-repo check so
  // `archon --version` works the same as `archon version` from any directory.
  if (isVersionRequest(args)) {
    try {
      refreshCompiledInstallManifest(BUNDLED_IS_BINARY, process.execPath, BUNDLED_VERSION);
      const { versionCommand } = await loadRoute(() => import('./commands/version'));
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
    // parseArgs rejected before values.json was bound, so derive the flag
    // from raw argv to honor the --json stdout contract.
    const json = args.includes('--json');
    if (json) setLogLevel('silent');
    refreshCompiledInstallManifest(BUNDLED_IS_BINARY, process.execPath, BUNDLED_VERSION);
    await fail(json, `Error parsing arguments: ${err.message}`);
    if (!json) printUsage();
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
  const command = positionals[0];
  const subcommand = positionals[1];

  // setup/doctor/telemetry default to warn to avoid Pino info JSON interleaving with their human-readable output; lazy loggers pick up this level at first creation
  const isInteractiveCommand =
    command === 'setup' || command === 'doctor' || command === 'telemetry';
  const suppressByDefault = isInteractiveCommand && !values.verbose && !isVerboseBoot();
  const rawTranscriptCommand = command === 'workflow' && subcommand === 'logs';
  // Apply output policy before install discovery: its best-effort debug logs
  // must never prefix a machine-readable response.
  if (jsonFlag || rawTranscriptCommand) {
    setLogLevel('silent');
  } else if (values.quiet || suppressByDefault) {
    setLogLevel('warn');
  } else if (values.verbose) {
    setLogLevel('debug');
  }
  refreshCompiledInstallManifest(BUNDLED_IS_BINARY, process.execPath, BUNDLED_VERSION);

  // Handle help flag — route through the scoped renderer using the already-
  // parsed positionals so `archon <command> [--subcommand] --help` shows only
  // the matching slice instead of the full index.
  if (values.help) {
    printUsageFor(command, subcommand);
    await shutdownTelemetry();
    return 0;
  }

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
    'conversations',
  ];
  const requiresGitRepo = !noGitCommands.includes(command ?? '');
  let detachedRunConfig: WorkflowRunConfigInput | undefined;

  try {
    const detachedRunConfigPayload = values['internal-detached-run-config'];
    if (
      command === 'workflow' &&
      subcommand === 'run' &&
      typeof detachedRunConfigPayload === 'string'
    ) {
      const { decodeWorkflowRunConfigHandoff } =
        await import('@archon/core/config/run-config-handoff');
      detachedRunConfig = decodeWorkflowRunConfigHandoff(detachedRunConfigPayload);
      // Fail-fast for the decode step, not a second copy of the invariant: `workflow.ts`
      // still owns this rejection for every caller. A legitimately spawned detached child
      // cannot reach it — the parent refuses to seal a config for a continuation before it
      // forks — so this only fires on a hand-built `--internal-detached-run-config`, and
      // saves it a database round-trip on the way to the same message.
      if (resumeFlag) throw new Error(RESUME_RUN_CONFIG_CONFLICT);
    }

    const configOutsideRun = rejectConfigOutsideRun(command, subcommand, values.config);
    if (configOutsideRun) {
      console.error(configOutsideRun);
      return 1;
    }
    // `archon continue` was removed (#2846). Intercepted before the git gate so
    // stale invocations get the replacement pointer in any directory.
    if (command === 'continue') {
      return await fail(
        jsonFlag,
        "Removed: 'archon continue' inferred a run from a branch name.\n" +
          'Use: archon workflow run <name> --adopt <run-id> <input>\n' +
          'Find a prior run id with: archon workflow runs --open (or workflow get <run-id>)'
      );
    }
    // Note: orphaned run cleanup moved to `workflow cleanup` command only.
    // Running it on every CLI startup killed parallel workflow runs (all
    // 'running' status rows were marked failed by each new process).

    // Marketplace search doesn't need a git repo — handle before git validation
    if (command === 'workflow' && subcommand === 'search') {
      const query = positionals[2];
      try {
        const { workflowSearchCommand } = await loadRoute(() => import('./commands/workflow'));
        await workflowSearchCommand(query, jsonFlag);
      } catch (error) {
        const err = error as Error;
        if (jsonFlag) {
          await writeJsonLine({ ok: false, error: err.message });
        } else {
          console.error(`Error: ${err.message}`);
        }
        return 1;
      }
      return 0;
    }

    // Fixture testing reads workflow files only — handle before git validation,
    // like marketplace search above.
    if (command === 'workflow' && subcommand === 'test') {
      const target = positionals[2];
      try {
        const [git, { workflowTestCommand }] = await Promise.all([
          import('@archon/git'),
          loadRoute(() => import('./commands/workflow')),
        ]);
        // Resolve to the repo root like the git gate below does, so project
        // workflow discovery reads the repository, not a subdirectory of it.
        const testCwd = requiresGitRepo ? ((await git.findRepoRoot(cwd)) ?? cwd) : cwd;
        return await workflowTestCommand(testCwd, target, { json: jsonFlag, targetCwd: cwd });
      } catch (error) {
        const err = error as Error;
        if (jsonFlag) {
          await writeJsonLine({ ok: false, error: err.message });
        } else {
          console.error(`Error: ${err.message}`);
        }
        return 1;
      }
    }

    // Validate working directory exists
    let effectiveCwd = cwd;
    if (requiresGitRepo) {
      if (!existsSync(cwd)) {
        return await fail(jsonFlag, `Error: Directory does not exist: ${cwd}`);
      }

      // Validate git repository and resolve to root
      const git = await import('@archon/git');
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
        // Canonicalize through the one shared `default_cwd` canonicalizer, so
        // this lookup asks for exactly the string registration stored. Using a
        // different realpath variant here is what hid every CLI-registered
        // folder project on Windows behind a false "Not in a git repository"
        // (#2927). It also covers an explicit `--cwd`, which — unlike
        // `process.cwd()` — arrives with its symlinks unresolved.
        const realCwd = await canonicalizeProjectPath(cwd);
        // The DB may be unreachable. A lookup failure must NOT crash pre-dispatch
        // (workflow/isolation commands still need to surface a clear error rather
        // than a stack trace) — capture it and, if connection-shaped, report
        // "database unavailable" instead of the misleading "not a git repository".
        let folderCodebase: { default_cwd: string; kind: 'repo' | 'folder' } | null = null;
        let gateLookupError: Error | null = null;
        try {
          const codebaseDb = await loadRoute(() => import('@archon/core/db/codebases'), {
            database: true,
          });
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
          return await fail(
            jsonFlag,
            [
              'Error: Could not verify project registration — the database is unavailable.',
              `  ${gateLookupError.message}`,
              '  Check that your database is running (or DATABASE_URL is set), then retry.',
            ].join('\n')
          );
        } else {
          return await fail(
            jsonFlag,
            [
              'Error: Not in a git repository.',
              'The Archon CLI must be run from within a git repository.',
              'Either navigate to a git repo or use --cwd to specify one.',
              'Or register this folder as a project: run with --folder, or use /register-project in chat.',
            ].join('\n')
          );
        }
      }
    }

    switch (command) {
      case 'version': {
        const { versionCommand } = await loadRoute(() => import('./commands/version'));
        await versionCommand();
        break;
      }

      case 'help': {
        // Mirror `archon <command> [--subcommand] --help`: bare `archon help`
        // is the global index; `archon help <cmd>` scopes to one command;
        // `archon help <cmd> <subcmd>` scopes further to one subcommand.
        printUsageFor(positionals[1], positionals[2]);
        break;
      }

      case 'chat': {
        const chatMessage = positionals.slice(1).join(' ');
        if (!chatMessage) return await fail(jsonFlag, 'Usage: archon chat <message>');
        const { chatCommand } = await loadRoute(() => import('./commands/chat'), {
          providers: true,
          database: true,
        });
        await chatCommand(chatMessage);
        break;
      }

      case 'setup': {
        const rawScope = values.scope as string | undefined;
        if (rawScope !== undefined && rawScope !== 'home' && rawScope !== 'project') {
          return await fail(
            jsonFlag,
            `Error: Invalid --scope: "${rawScope}". Must be "home" or "project".`
          );
        }
        const scope: 'home' | 'project' = rawScope ?? 'home';
        const forceFlag = (values.force as boolean | undefined) ?? false;
        // For --scope project, resolve to the git repo root so running from a
        // subdirectory writes to <repo-root>/.archon/.env (what loadArchonEnv
        // reads at boot) — not <subdir>/.archon/.env.
        let repoPath = cwd;
        if (scope === 'project') {
          const git = await import('@archon/git');
          const repoRoot = await git.findRepoRoot(cwd);
          if (!repoRoot) {
            return await fail(
              jsonFlag,
              [
                'Error: --scope project requires running from inside a git repository.',
                'Run from the repo root, pass --cwd <repo>, or use --scope home.',
              ].join('\n')
            );
          }
          repoPath = repoRoot;
        }
        const { setupCommand } = await loadRoute(() => import('./commands/setup'), {
          providers: true,
          database: true,
        });
        await setupCommand({ spawn: spawnFlag, repoPath, scope, force: forceFlag });
        break;
      }

      case 'workflow': {
        const modelOnContinue = rejectModelOnContinue(subcommand, values.model);
        if (modelOnContinue) {
          return await fail(jsonFlag, modelOnContinue);
        }
        const {
          workflowListCommand,
          WorkflowListLookupError: workflowListLookupError,
          workflowRunCommand,
          workflowStatusCommand,
          workflowGetCommand,
          workflowLogsCommand,
          workflowWaitCommand,
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
          workflowInstallCommand,
          isValidEventType,
        } = await loadRoute(() => import('./commands/workflow'), {
          // `resume`, `approve`, `reject`, and `respond` all reach `workflowRunCommand`,
          // so they need the registry for the same reason `run` does. They need it more,
          // in fact: a continuation resolves its workflow from the run's captured source,
          // and passing that capture's `source_config` into discovery is what skips
          // `loadConfig()` — the call that self-registers providers for every other
          // route. Without this, the loader rejects any `provider:`-scoped workflow and
          // the run is reported as missing from its own capture.
          providers: subcommand === 'run' || isContinueSubcommand(subcommand),
          database: true,
        });
        switch (subcommand) {
          case 'list': {
            const workflowName = positionals[2];
            if (positionals[3] !== undefined) {
              return await fail(jsonFlag, 'Usage: archon workflow list [name] [--full] [--json]');
            }
            try {
              await workflowListCommand(effectiveCwd, {
                json: jsonFlag,
                name: workflowName,
                full: values.full as boolean | undefined,
              });
            } catch (error) {
              if (jsonFlag && error instanceof workflowListLookupError) {
                await writeJsonLine({
                  ok: false,
                  error: error.message,
                  errors: error.loadErrors,
                });
                return 1;
              }
              throw error;
            }
            break;
          }

          case 'run': {
            const workflowName = positionals[2];
            if (!workflowName) {
              return await fail(jsonFlag, 'Usage: archon workflow run <name> [message]');
            }
            const userMessage = positionals.slice(3).join(' ') || '';
            const configOnContinue = rejectConfigOnContinue(resumeFlag, values.config);
            if (configOnContinue) {
              console.error(configOnContinue);
              return 1;
            }
            if (branchName !== undefined && noWorktree) {
              return await fail(
                jsonFlag,
                'Error: --branch and --no-worktree are mutually exclusive.\n' +
                  '  --branch creates an isolated worktree (safe).\n' +
                  '  --no-worktree runs directly in your repo (no isolation).\n' +
                  'Use one or the other.'
              );
            }
            if (noWorktree && fromBranch !== undefined) {
              return await fail(
                jsonFlag,
                'Error: --from/--from-branch has no effect with --no-worktree.\n' +
                  'Remove --from or drop --no-worktree.'
              );
            }
            if (noWorktree && baseBranch !== undefined) {
              return await fail(
                jsonFlag,
                'Error: --base has no effect with --no-worktree.\n' +
                  'Remove --base or drop --no-worktree.'
              );
            }
            if (resumeFlag && branchName !== undefined) {
              return await fail(
                jsonFlag,
                'Error: --resume and --branch are mutually exclusive.\n' +
                  '  --resume reuses the existing worktree from the failed run.\n' +
                  '  Remove --branch when using --resume.'
              );
            }
            // `--workflow-source` picks the authoring directory. It is fresh-run only:
            // a resume executes the source its run already captured, so accepting a
            // different one here would promise a swap that cannot happen.
            let workflowSource: string | undefined;
            if (workflowSourceFlag !== undefined) {
              if (resumeFlag) {
                return await fail(
                  jsonFlag,
                  'Error: --workflow-source and --resume are mutually exclusive.\n' +
                    '  A resumed run executes the source it captured when it started.\n' +
                    '  Drop --workflow-source, or start a fresh run to pick up new source.'
                );
              }
              if (containerFlag) {
                // A container run executes inside the container, which mounts the folder
                // project and nothing else. The capture lives outside that mount, so a
                // separate source root could be frozen but never read — the run would
                // fail looking for its own commands. Refuse the combination rather than
                // ship a flag that silently does not apply.
                return await fail(
                  jsonFlag,
                  'Error: --workflow-source and --container are mutually exclusive.\n' +
                    '  A container run reads source from the project it mounts.\n' +
                    '  Run without --container to execute source from another directory.'
                );
              }
              workflowSource = resolve(workflowSourceFlag);
              if (!(await isPathDirectory(workflowSource))) {
                return await fail(
                  jsonFlag,
                  `Error: --workflow-source is not a directory: ${workflowSource}\n` +
                    '  Point it at the checkout holding .archon/workflows/.'
                );
              }
            }
            const options = {
              branchName,
              fromBranch,
              baseBranch,
              adoptRunId: values.adopt as string | undefined,
              supersedesRunId: values.supersedes as string | undefined,
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
              configPath:
                typeof values.config === 'string' ? resolve(cwd, values.config) : undefined,
              detachedRunConfig,
              detachedRunId: values['internal-detached-run-id'] as string | undefined,
            };
            await workflowRunCommand(effectiveCwd, workflowName, userMessage, options);
            break;
          }

          case 'status':
            if (positionals[2] !== undefined) {
              return await fail(
                jsonFlag,
                'Usage: archon workflow status [--all] [--json] [--verbose] [--events]\n' +
                  'To show a single run, use: archon workflow get <run-id>'
              );
            }
            await workflowStatusCommand(effectiveCwd, {
              json: jsonFlag,
              verbose: values.verbose as boolean | undefined,
              rawEvents: values.events as boolean | undefined,
              all: values.all as boolean | undefined,
            });
            break;

          case 'get': {
            const getRunId = positionals[2];
            if (!getRunId || positionals[3] !== undefined) {
              return await fail(
                jsonFlag,
                'Usage: archon workflow get <run-id> [--json] [--verbose] [--events]'
              );
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

          case 'logs': {
            const logsRunId = positionals[2];
            if (!logsRunId || positionals[3] !== undefined) {
              return await fail(false, 'Usage: archon workflow logs <run-id> [--follow]');
            }
            if (jsonFlag) {
              return await fail(
                false,
                'Error: workflow logs already emits JSONL; --json is not supported.'
              );
            }
            if (values.events) {
              return await fail(
                false,
                'Error: --events applies to workflow status/get, not workflow logs.'
              );
            }
            return await workflowLogsCommand(logsRunId, Boolean(values.follow), effectiveCwd);
          }

          case 'wait': {
            const waitRunId = positionals[2];
            if (!waitRunId || positionals[3] !== undefined) {
              return await fail(
                jsonFlag,
                'Usage: archon workflow wait <run-id> [--json] [--timeout <seconds>]'
              );
            }
            const rawTimeout = values.timeout as string | undefined;
            let timeoutSeconds: number | undefined;
            if (rawTimeout !== undefined) {
              timeoutSeconds = Number(rawTimeout);
              if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
                return await fail(
                  jsonFlag,
                  `Error: --timeout must be a positive number of seconds, got '${rawTimeout}'.`
                );
              }
            }
            // `return await`, not `break`: the wait's own exit code (3 for a deadline)
            // has to reach the shell instead of falling through to the generic success.
            return await workflowWaitCommand(waitRunId, jsonFlag, effectiveCwd, timeoutSeconds);
          }

          case 'runs': {
            const rawLimit = values.limit as string | undefined;
            let limit: number | undefined;
            if (rawLimit !== undefined) {
              limit = Number(rawLimit);
              if (!Number.isInteger(limit) || limit < 1) {
                return await fail(
                  jsonFlag,
                  `Error: --limit must be a positive integer, got '${rawLimit}'.`
                );
              }
            }
            await workflowRunsCommand(effectiveCwd, {
              json: jsonFlag,
              all: values.all as boolean | undefined,
              status: values.status as string | undefined,
              limit,
              open: values.open as boolean | undefined,
            });
            break;
          }

          case 'resume': {
            const resumeRunId = positionals[2];
            if (!resumeRunId) {
              return await fail(jsonFlag, 'Usage: archon workflow resume <run-id>');
            }
            await workflowResumeCommand(resumeRunId, jsonFlag, effectiveCwd, detachFlag);
            break;
          }

          case 'abandon': {
            const abandonRunId = positionals[2];
            if (!abandonRunId) {
              return await fail(jsonFlag, 'Usage: archon workflow abandon <run-id>');
            }
            await workflowAbandonCommand(abandonRunId, jsonFlag, effectiveCwd);
            break;
          }

          case 'cancel': {
            const cancelRunId = positionals[2];
            if (!cancelRunId) {
              return await fail(jsonFlag, 'Usage: archon workflow cancel <run-id>');
            }
            await workflowCancelCommand(cancelRunId, jsonFlag, effectiveCwd);
            break;
          }

          case 'approve': {
            const approveRunId = positionals[2];
            if (!approveRunId) {
              return await fail(jsonFlag, 'Usage: archon workflow approve <run-id> [comment]');
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
              return await fail(jsonFlag, 'Usage: archon workflow reject <run-id> [reason]');
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
              return await fail(
                jsonFlag,
                'Usage: archon workflow respond <run-id> <decision> [text]\n' +
                  "  'approve' and 'reject' are sugar for the equivalent dedicated commands; " +
                  'any other decision must be one the gate actually declared.'
              );
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
              return await fail(
                jsonFlag,
                'Usage: archon workflow cleanup [days]\n' +
                  '  days: delete terminal runs older than N days (default: 7)'
              );
            }
            await workflowCleanupCommand(days);
            break;
          }

          case 'reset-sessions': {
            const workflowName = positionals[2];
            const extras = positionals.slice(3);
            if (!workflowName) {
              return await fail(
                jsonFlag,
                'Usage: archon workflow reset-sessions <workflow-name> [--scope <key>] [--node <id>] [--yes] [--json]\n' +
                  '  Without --scope: deletes persisted sessions across ALL scopes (requires --yes).'
              );
            }
            // Reject extra positionals — this is a destructive command and silently
            // dropping `archon workflow reset-sessions wf planner` (likely intent: filter to
            // node "planner") to a cross-scope wipe would be a foot-gun.
            if (extras.length > 0) {
              return await fail(
                jsonFlag,
                'Usage: archon workflow reset-sessions <workflow-name> [--scope <key>] [--node <id>] [--yes] [--json]\n' +
                  `Error: unexpected positional argument(s): ${extras.join(' ')}. Use --node <id> to filter by node.`
              );
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
              const problem =
                action === undefined
                  ? 'Missing workflow event subcommand'
                  : `Unknown workflow event subcommand: ${action}`;
              return await fail(jsonFlag, `${problem}\nAvailable: emit`);
            }
            const runId = values['run-id'] as string | undefined;
            const eventType = values.type as string | undefined;
            if (!runId) {
              return await fail(
                jsonFlag,
                'Usage: archon workflow event emit --run-id <run-id> --type <event-type>\n' +
                  'Error: --run-id is required'
              );
            }
            if (!eventType) {
              return await fail(
                jsonFlag,
                'Usage: archon workflow event emit --run-id <run-id> --type <event-type>\n' +
                  'Error: --type is required'
              );
            }
            if (!isValidEventType(eventType)) {
              const { WORKFLOW_EVENT_TYPES } = await import('@archon/workflows/store');
              return await fail(
                jsonFlag,
                `Error: unknown event type: ${eventType}\nValid types: ${WORKFLOW_EVENT_TYPES.join(', ')}`
              );
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
              return await fail(jsonFlag, 'Usage: archon workflow install <slug> [--force]');
            }
            const forceFlag = values.force as boolean | undefined;
            await workflowInstallCommand(installSlug, effectiveCwd, forceFlag);
            break;
          }

          default: {
            const problem =
              subcommand === undefined
                ? 'Missing workflow subcommand'
                : `Unknown workflow subcommand: ${subcommand}`;
            return await fail(
              jsonFlag,
              `${problem}\nAvailable: list, run, status, get, wait, runs, resume, cancel, abandon, approve, reject, cleanup, event, search, install`
            );
          }
        }
        break;
      }

      case 'isolation': {
        const { isolationListCommand, isolationCleanupCommand, isolationCleanupMergedCommand } =
          await loadRoute(() => import('./commands/isolation'), { database: true });
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

          default: {
            const problem =
              subcommand === undefined
                ? 'Missing isolation subcommand'
                : `Unknown isolation subcommand: ${subcommand}`;
            return await fail(jsonFlag, `${problem}\nAvailable: list, cleanup`);
          }
        }
        break;
      }

      case 'validate': {
        const { validateWorkflowsCommand, validateCommandsCommand } = await loadRoute(
          () => import('./commands/validate')
        );
        switch (subcommand) {
          case 'workflows': {
            const validateName = positionals[2];
            return await validateWorkflowsCommand(effectiveCwd, validateName, jsonFlag);
          }

          case 'commands': {
            const validateName = positionals[2];
            return await validateCommandsCommand(effectiveCwd, validateName, jsonFlag);
          }

          default: {
            const problem =
              subcommand === undefined
                ? 'Missing validate target'
                : `Unknown validate target: ${subcommand}`;
            return await fail(jsonFlag, `${problem}\nAvailable: workflows, commands`);
          }
        }
      }

      case 'complete': {
        const branches = positionals.slice(1);
        if (branches.length === 0) {
          return await fail(jsonFlag, 'Usage: archon complete <branch-name> [branch2 ...]');
        }
        const forceFlag = Boolean(values.force);
        const { isolationCompleteCommand } = await loadRoute(() => import('./commands/isolation'), {
          database: true,
        });
        await isolationCompleteCommand(branches, { force: forceFlag, deleteRemote: true });
        break;
      }

      case 'serve': {
        const servePort = values.port !== undefined ? Number(values.port) : undefined;
        const downloadOnly = Boolean(values['download-only']);
        const { serveCommand } = await loadRoute(() => import('./commands/serve'), {
          database: !downloadOnly,
        });
        return await serveCommand({ port: servePort, downloadOnly });
      }

      case 'doctor': {
        const { doctorCommand } = await loadRoute(() => import('./commands/doctor'), {
          database: true,
        });
        return await doctorCommand(undefined, Boolean(values.full));
      }

      case 'auth': {
        switch (subcommand) {
          case 'github': {
            const { authGithubCommand } = await loadRoute(() => import('./commands/auth'), {
              database: true,
            });
            return await authGithubCommand();
          }
          default: {
            const problem =
              subcommand === undefined
                ? 'Missing auth subcommand'
                : `Unknown auth subcommand: ${subcommand}`;
            return await fail(jsonFlag, `${problem}\nAvailable: github`);
          }
        }
      }

      case 'conversations': {
        // Both subcommands take flags only; a stray token is a typo that must not
        // silently widen a list or ride along on an ownership-changing claim.
        const extras = positionals.slice(2);
        if (extras.length > 0) {
          return await fail(
            jsonFlag,
            `Error: unexpected positional argument(s): ${extras.join(' ')}. ` +
              "'conversations list' and 'conversations claim' take flags only."
          );
        }
        const { conversationsClaimCommand, conversationsListCommand } = await loadRoute(
          () => import('./commands/conversations'),
          { database: true }
        );
        switch (subcommand) {
          case 'list':
            return await conversationsListCommand({
              unowned: values.unowned as boolean | undefined,
              platform: values.platform as string | undefined,
              limit: values.limit as string | undefined,
            });
          case 'claim':
            return await conversationsClaimCommand({
              user: values.user as string | undefined,
              platform: values.platform as string | undefined,
              before: values.before as string | undefined,
              dryRun: dryRunFlag,
              yes: values.yes as boolean | undefined,
            });
          default: {
            const problem =
              subcommand === undefined
                ? 'Missing conversations subcommand'
                : `Unknown conversations subcommand: ${subcommand}`;
            return await fail(
              jsonFlag,
              `${problem}\nAvailable: list --unowned, claim --user <archon-user-id>`
            );
          }
        }
      }

      case 'ai': {
        const {
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
        } = await loadRoute(() => import('./commands/ai'), {
          providers: true,
          database: true,
        });
        switch (subcommand) {
          case 'key': {
            const action = positionals[2];
            if (action !== 'set') {
              return await fail(jsonFlag, 'Usage: archon ai key set <provider>');
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
                return await fail(
                  jsonFlag,
                  'Usage: archon ai tier set <small|medium|large> <provider> <model> [--effort <e>] [--scope user|install] | tier list [--json] | tier unset <tier> [--scope user|install]'
                );
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
                return await fail(
                  jsonFlag,
                  'Usage: archon ai alias set <@name> <provider> <model> [--effort <e>] [--scope user|install] | alias list [--json] | alias unset <@name> [--scope user|install]'
                );
            }
          }
          case 'default':
            return await aiDefaultCommand(
              positionals[2],
              positionals[3],
              values.scope as string | undefined
            );
          default: {
            const problem =
              subcommand === undefined
                ? 'Missing ai subcommand'
                : `Unknown ai subcommand: ${subcommand}`;
            return await fail(
              jsonFlag,
              `${problem}\nAvailable: key set <provider>, login <provider>, list, logout <provider>, tier set|list|unset, alias set|list|unset, default <provider> [<model>]`
            );
          }
        }
      }

      case 'telemetry': {
        const { telemetryStatusCommand, telemetryResetCommand } = await loadRoute(
          () => import('./commands/telemetry')
        );
        switch (subcommand) {
          case 'status':
            return telemetryStatusCommand();
          case 'reset':
            return telemetryResetCommand();
          default: {
            const problem =
              subcommand === undefined
                ? 'Missing telemetry subcommand'
                : `Unknown telemetry subcommand: ${subcommand}`;
            return await fail(jsonFlag, `${problem}\nAvailable: status, reset`);
          }
        }
      }

      case 'skill': {
        switch (subcommand) {
          case 'install': {
            // Optional positional path; otherwise install into the resolved cwd.
            const targetArg = positionals[2];
            const targetPath = targetArg ? resolve(targetArg) : cwd;
            const { skillInstallCommand } = await loadRoute(() => import('./commands/skill'));
            return await skillInstallCommand(targetPath);
          }

          default: {
            const problem =
              subcommand === undefined
                ? 'Missing skill subcommand'
                : `Unknown skill subcommand: ${subcommand}`;
            return await fail(jsonFlag, `${problem}\nAvailable: install`);
          }
        }
      }

      default: {
        const problem = command === undefined ? 'Missing command' : `Unknown command: ${command}`;
        // printUsage() writes human text to stdout, which would corrupt the
        // machine-readable payload under --json.
        if (jsonFlag) {
          return await fail(true, problem);
        }
        console.error(problem);
        printUsage();
        return 1;
      }
    }
    await printUpdateNotice(values.quiet as boolean | undefined);
    return 0;
  } catch (error) {
    const err = error as Error;
    // A detached child reports its run's own failure with a reserved status so its
    // launcher can tell that apart from a child that died before the run started.
    const exitCode = resolveCliExitCode(err);
    if (values.json as boolean | undefined) {
      await writeJsonLine({ ok: false, error: err.message });
      return exitCode;
    }
    console.error(`Error: ${err.message}`);
    if (process.env.DEBUG) {
      console.error(err.stack);
    }
    return exitCode;
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
