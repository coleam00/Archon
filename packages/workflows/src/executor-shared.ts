/**
 * Shared helpers for executor.ts and dag-executor.ts.
 *
 * Extracted here once the Rule of Three was met — both files had
 * identical copies of these error-classification and prompt-building
 * utilities. Single source of truth; no logic changes from either copy.
 */
import { readFile } from 'fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'path';
import type { IWorkflowPlatform, WorkflowDeps, WorkflowMessageMetadata } from './deps';
import * as archonPaths from '@archon/paths';
import { liveSourceRoots, type WorkflowSourceRoots } from './workflow-source';
import { BUNDLED_COMMANDS, isBinaryBuild } from './defaults/bundled-defaults';
import { createLogger } from '@archon/paths';
import { isValidCommandName } from './command-validation';
import type { LoadCommandResult } from './schemas';
import { substituteInputRefs, type JsonValue } from './output-ref';
import { getPackagedResourceDirectory, parsePackagedResourceReference } from './packaged-workflow';

/** Lazy-initialized logger */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.executor-shared');
  return cachedLog;
}

// ─── Error Classification ────────────────────────────────────────────────────

/** Result of error classification */
export type ErrorType = 'TRANSIENT' | 'FATAL' | 'UNKNOWN';

const QUOTA_EXHAUSTION_PATTERNS = [
  'session limit',
  'usage limit reached',
  'credit exhaustion',
  'credit balance',
] as const;

/** Fatal errors: authentication/authorization failures plus quota exhaustion. */
export const FATAL_PATTERNS = [
  'unauthorized',
  'forbidden',
  'invalid token',
  'authentication failed',
  'permission denied',
  '401',
  '403',
  ...QUOTA_EXHAUSTION_PATTERNS,
];

/** Ambiguous fatal patterns that yield to concrete transient evidence. */
const FALLBACK_FATAL_PATTERNS = ['auth error'];

/** Transient error patterns - temporary issues that may resolve with retry */
export const TRANSIENT_PATTERNS = [
  'timeout',
  'econnrefused',
  'econnreset',
  'etimedout',
  'rate limit',
  'too many requests',
  '429',
  '503',
  '502',
  '529', // Anthropic HTTP 529 = service overloaded
  'overloaded', // Anthropic/Minimax overload message text
  'at capacity', // Codex/OpenAI model-level saturation
  'network error',
  'stream closed without yielding content', // empty provider stream (#2706): silent rejection or interruption, not a node defect
  'socket hang up',
  'exited with code',
  'claude code crash',
];

/**
 * Check if error message matches any pattern in the list.
 */
export function matchesPattern(message: string, patterns: string[]): boolean {
  return patterns.some(pattern => message.includes(pattern));
}

/**
 * Classify an error to determine if it's transient (can retry) or fatal (should fail).
 * Decisive FATAL patterns take priority over TRANSIENT patterns to prevent an error
 * containing both (e.g. "unauthorized: process exited with code 1") from being retried.
 * Ambiguous provider wrapper text such as "auth error" is fatal only when no concrete
 * transient signal matches.
 */
export function classifyError(error: Error): ErrorType {
  const message = error.message.toLowerCase();

  if (matchesPattern(message, FATAL_PATTERNS)) {
    return 'FATAL';
  }
  if (matchesPattern(message, TRANSIENT_PATTERNS)) {
    return 'TRANSIENT';
  }
  if (matchesPattern(message, FALLBACK_FATAL_PATTERNS)) {
    return 'FATAL';
  }
  return 'UNKNOWN';
}

/**
 * Rate/concurrency pressure (429, provider overload) — a subset of TRANSIENT that
 * sheds load on a minutes-scale window, so it earns its own patient backoff policy
 * (see {@link getRetryDelayMs}) instead of the generic short exponential one (#2706).
 */
export const RATE_LIMIT_PATTERNS = [
  '429',
  'rate limit',
  'too many requests',
  'overloaded',
  'at capacity',
] as const;

/** Retry budget for rate-limited failures, replacing the node's own maxRetries when one is seen. */
export const RATE_LIMIT_MAX_RETRIES = 5;

/** Flat delay center for rate-limit retries; jitter widens it to ±50% in {@link getRetryDelayMs}. */
export const RATE_LIMIT_RETRY_DELAY_MS = 45_000;

export function isRateLimitError(error: string): boolean {
  const message = error.toLowerCase();
  return RATE_LIMIT_PATTERNS.some(pattern => message.includes(pattern));
}

/**
 * Delay before retry attempt N for a failed attempt with this error message.
 *
 * Rate-limit failures back off FLAT at ~45s ±50% jitter: providers shedding load
 * recover on a minutes-scale window with no retry-after signal (#2706), so exponential
 * from 3s either exhausts before the window opens or over-waits once it does; flat +
 * jitter spreads concurrent nodes apart without thundering-herd re-synchronization.
 * Everything else keeps the caller's base × 2^attempt exponential shape.
 */
export function getRetryDelayMs(
  errorMessage: string,
  attempt: number,
  baseDelayMs: number
): number {
  if (isRateLimitError(errorMessage)) {
    return Math.round(RATE_LIMIT_RETRY_DELAY_MS * (0.5 + Math.random()));
  }
  return baseDelayMs * Math.pow(2, attempt);
}

export function isQuotaExhaustionError(error: string): boolean {
  const message = error.toLowerCase();
  return QUOTA_EXHAUSTION_PATTERNS.some(pattern => message.includes(pattern));
}

/** Parse only provider reset forms that carry an unambiguous instant/duration. */
export function extractQuotaResetAt(error: string, now = new Date()): Date | null {
  const epoch = /usage limit reached\|(\d{10,13})/i.exec(error)?.[1];
  if (epoch !== undefined) {
    const raw = Number(epoch);
    const millis = epoch.length === 10 ? raw * 1000 : raw;
    const parsed = new Date(millis);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  const relative = /resets\s+in\s+(\d+(?:\.\d+)?)\s*(m(?:in(?:ute)?s?)?|h(?:ours?)?)/i.exec(error);
  if (relative?.[1] !== undefined && relative[2] !== undefined) {
    const amount = Number(relative[1]);
    const multiplier = relative[2].toLowerCase().startsWith('h') ? 60 * 60 * 1000 : 60 * 1000;
    const parsed = new Date(now.getTime() + amount * multiplier);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return null;
}

/**
 * Map the retry-oriented {@link ErrorType} to the telemetry wire enum. The
 * telemetry event carries ONLY this fixed-enum class — never error text.
 */
export function toTelemetryErrorClass(errorType: ErrorType): archonPaths.WorkflowErrorClass {
  switch (errorType) {
    case 'FATAL':
      return 'fatal';
    case 'TRANSIENT':
      return 'transient';
    case 'UNKNOWN':
      return 'unknown';
    default: {
      // Exhaustiveness guard: a future ErrorType variant fails compilation
      // here instead of silently sending `undefined` to the telemetry wire.
      const exhaustive: never = errorType;
      return exhaustive;
    }
  }
}

// ─── Subprocess Failure Formatting ───────────────────────────────────────────

/** Max characters of stderr/message we keep in user-facing and logged fields. */
const SUBPROCESS_ERROR_MAX_CHARS = 2000;

/**
 * Raw ExecFileException shape from Node's `child_process.execFile`. For inline
 * scripts via `bash -c <body>` / `bun -e <body>` the entire script body is
 * embedded in `err.message`, `err.cmd`, and the first line of `err.stack` —
 * which is why `formatSubprocessFailure` strips the prefix and exposes a
 * controlled `logFields` subset rather than the raw error.
 */
interface RawSubprocessError {
  message?: string;
  stderr?: string;
  stdout?: string;
  // Numeric exit code OR errno symbol (e.g. 'ENOENT') — mirrors ExecFileException.
  code?: number | string | null;
  killed?: boolean;
  cmd?: string;
}

/**
 * Produce a concise, diagnostic-first summary of a failed subprocess.
 *
 * User-visible output strips Node's `"Command failed: <cmd>"` prefix (which for
 * inline scripts contains the full script body) and prefers stderr when present.
 * Log fields expose a controlled, tail-truncated subset — never the full `err`
 * object, to prevent Pino's default error serializer from emitting three copies
 * of the script body (`err.message`, `err.stack`, `err.cmd`).
 */
export function formatSubprocessFailure(
  err: RawSubprocessError,
  label: string
): { userMessage: string; logFields: Record<string, unknown> } {
  const stderr = (err.stderr ?? '').trim();
  const rawMessage = (err.message ?? '').trim();

  // The first line of Node's ExecFileException.message is `Command failed: <cmd>`,
  // and for `bash -c <body>` / `bun -e <body>` that line embeds the full script
  // body. Strip it so user-facing output never re-leaks the body.
  const hasCommandFailedPrefix = rawMessage.startsWith('Command failed:');
  const bodyAfterPrefix = hasCommandFailedPrefix
    ? rawMessage.split('\n').slice(1).join('\n').trim()
    : rawMessage;

  let diagnostic: string;
  if (stderr) {
    diagnostic = stderr;
  } else if (bodyAfterPrefix) {
    diagnostic = bodyAfterPrefix;
  } else if (hasCommandFailedPrefix) {
    // Prefix was the entire message — exit code in the suffix is the only signal.
    diagnostic = 'no diagnostic output';
  } else {
    diagnostic = 'unknown error';
  }

  const truncated =
    diagnostic.length > SUBPROCESS_ERROR_MAX_CHARS
      ? diagnostic.slice(-SUBPROCESS_ERROR_MAX_CHARS) + '\n…[truncated]'
      : diagnostic;

  const exitSuffix = err.code != null ? ` [exit ${String(err.code)}]` : '';

  const stderrTail =
    stderr.length > SUBPROCESS_ERROR_MAX_CHARS ? stderr.slice(-SUBPROCESS_ERROR_MAX_CHARS) : stderr;

  return {
    userMessage: `${label} failed${exitSuffix}: ${truncated}`,
    logFields: {
      exitCode: err.code ?? undefined,
      killed: err.killed === true,
      stderrTail: stderrTail.length > 0 ? stderrTail : undefined,
    },
  };
}

// ─── Credit/Limit Exhaustion Detection ──────────────────────────────────────

/** Patterns that indicate a subscription session limit in streamed assistant output */
const SESSION_LIMIT_OUTPUT_PATTERNS = [
  'hit your session limit',
  'session limit reached',
  'session limit has been reached',
];

/** Patterns that indicate pay-per-token credit exhaustion in streamed assistant output */
const CREDIT_EXHAUSTION_OUTPUT_PATTERNS = [
  "you're out of extra usage",
  'out of credits',
  'credit balance',
  'insufficient credit',
];

/** Extract a reset-time clause from a session-limit message, e.g. "resets 3am (America/Mexico_City)". */
function extractResetTime(text: string): string | null {
  const match = /resets\s+([^\n·.!]+)/i.exec(text);
  return match ? match[1].trim() : null;
}

/**
 * Detect credit/session-limit exhaustion in streamed node output text.
 *
 * The Claude SDK surfaces both subscription session limits and pay-per-token
 * credit exhaustion as normal assistant text messages rather than thrown errors.
 * This function checks the accumulated output for known phrases and returns an
 * actionable error string, or null if no limit is detected.
 *
 * @returns null if no limit detected; a session-limit string (instructs user to
 * abandon and retry after reset) or a credit-exhaustion string (instructs user
 * to resume when credits refill).
 */
export function detectCreditExhaustion(text: string): string | null {
  const lower = text.toLowerCase();

  if (SESSION_LIMIT_OUTPUT_PATTERNS.some(p => lower.includes(p))) {
    const resetTime = extractResetTime(text);
    return resetTime
      ? `Claude session limit reached — resets ${resetTime}. Abandon this run and retry after reset.`
      : 'Claude session limit reached — abandon this run and retry when the session resets.';
  }

  if (CREDIT_EXHAUSTION_OUTPUT_PATTERNS.some(p => lower.includes(p))) {
    return 'Credit exhaustion detected — resume when credits reset';
  }

  return null;
}

// ─── Command Loading ─────────────────────────────────────────────────────────

/**
 * Load command prompt from file.
 *
 * Two directories are in play and they are not interchangeable. `cwd` is the workspace
 * the run acts on: it owns config, and it is where a `commands.folder` setting is read
 * from. `sourceRoots` is where the command TEXT lives — the authoring checkout, or a
 * run's frozen capture of it. They describe the same place for an ordinary in-place run
 * and differ whenever a workflow authored in one checkout executes against another.
 * Passing `cwd` for both is what made a workflow's own commands invisible inside its
 * isolated worktree.
 *
 * @param deps - Workflow dependencies (for config loading)
 * @param cwd - Target workspace; owns config only
 * @param commandName - Name of the command (without .md extension)
 * @param configuredFolder - Optional additional folder from config to search
 * @param sourceRoots - Roots to resolve command files under; defaults to reading `cwd` live
 * @returns On success: `{ success: true, content }`. On failure: `{ success: false, reason, message }`.
 */
export async function loadCommandPrompt(
  deps: Pick<WorkflowDeps, 'loadConfig'>,
  cwd: string,
  commandName: string,
  configuredFolder?: string,
  sourceRoots?: WorkflowSourceRoots
): Promise<LoadCommandResult> {
  const roots = sourceRoots ?? liveSourceRoots(cwd);
  // Validate command name first
  if (!isValidCommandName(commandName)) {
    getLog().error({ commandName }, 'invalid_command_name');
    return {
      success: false,
      reason: 'invalid_name',
      message: `Invalid command name (potential path traversal): ${commandName}`,
    };
  }

  // Opt-out comes from the SOURCE when there is one — a capture carries the settings that
  // were in force when it was taken, so a resume cannot let the target's `defaults:`
  // decide whether the bundled scope counts. Falls back to reading `cwd` live.
  let loadDefaultCommands = sourceRoots?.config.load_default_commands;
  if (loadDefaultCommands === undefined) {
    try {
      loadDefaultCommands = (await deps.loadConfig(cwd)).defaults?.loadDefaultCommands ?? true;
    } catch (error) {
      const err = error as Error;
      getLog().warn(
        {
          err,
          cwd,
          note: 'Default commands will be loaded. Check your .archon/config.yaml if this is unexpected.',
        },
        'config_load_failed_using_defaults'
      );
      loadDefaultCommands = true;
    }
  }

  const packaged = parsePackagedResourceReference(commandName);
  if (packaged !== null) {
    if (packaged.owner.source === 'bundled') {
      if (!loadDefaultCommands) {
        return {
          success: false,
          reason: 'not_found',
          message: `Packaged command not found: ${packaged.name}.md`,
        };
      }
      // A captured run reads the bundled bytes IT froze, even in a binary: the capture
      // materialized the constants to files, and those are what its digest covers.
      if (isBinaryBuild() && roots.kind === 'live') {
        const content = BUNDLED_COMMANDS[commandName];
        if (content === undefined) {
          return {
            success: false,
            reason: 'not_found',
            message: `Packaged command not found: ${packaged.name}.md`,
          };
        }
        if (!content.trim()) {
          return {
            success: false,
            reason: 'empty_file',
            message: `Command file is empty: ${packaged.name}.md`,
          };
        }
        return { success: true, content };
      }
    }

    let workflowsRoot: string;
    if (packaged.owner.source === 'project') {
      if (roots.project === null) {
        return {
          success: false,
          reason: 'not_found',
          message: `Packaged command not found (no project source): ${packaged.name}.md`,
        };
      }
      workflowsRoot = join(roots.project, '.archon', 'workflows');
    } else if (packaged.owner.source === 'global') {
      workflowsRoot = roots.globalWorkflows;
    } else {
      workflowsRoot = roots.bundledWorkflows;
    }
    const filePath = join(
      getPackagedResourceDirectory(workflowsRoot, packaged.owner, 'commands'),
      `${packaged.name}.md`
    );
    try {
      const content = await readFile(filePath, 'utf-8');
      if (!content.trim()) {
        return {
          success: false,
          reason: 'empty_file',
          message: `Command file is empty: ${filePath}`,
        };
      }
      return { success: true, content };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      let reason: 'permission_denied' | 'not_found' | 'read_error';
      if (err.code === 'EACCES') {
        reason = 'permission_denied';
      } else if (err.code === 'ENOENT') {
        reason = 'not_found';
      } else {
        reason = 'read_error';
      }
      if (err.code !== 'ENOENT') {
        getLog().error({ err, commandName, filePath }, 'packaged_command_file_read_error');
      }
      return {
        success: false,
        reason,
        message:
          err.code === 'ENOENT'
            ? `Packaged command not found: ${filePath}`
            : `Error reading packaged command ${filePath}: ${err.message}`,
      };
    }
  }

  // Use command folder paths with optional configured folder.
  // Each scope is walked 1 subfolder deep so `triage/review.md` resolves as
  // `review` — matching the workflows/scripts convention. Resolution
  // precedence: repo > home (~/.archon/commands/) > bundled/app defaults.
  // The SOURCE's command folder, when a capture supplied one. `configuredFolder` is the
  // target's, which is the right answer only for an in-place run — for a captured run it
  // would search folders the frozen source never used.
  const searchPaths = archonPaths.getCommandFolderSearchPaths(
    sourceRoots?.config.command_folder ?? configuredFolder
  );
  const projectRoot = roots.project;
  const resolvedSearchPaths: string[] = [
    ...(projectRoot !== null ? searchPaths.map(folder => join(projectRoot, folder)) : []),
    roots.globalCommands,
  ];

  for (const dir of resolvedSearchPaths) {
    const entries = await archonPaths.findMarkdownFilesRecursive(dir, '', { maxDepth: 1 });
    const match = entries.find(e => e.commandName === commandName);
    if (!match) continue;

    const filePath = join(dir, match.relativePath);
    try {
      const content = await readFile(filePath, 'utf-8');
      if (!content.trim()) {
        getLog().error({ commandName }, 'command_file_empty');
        return {
          success: false,
          reason: 'empty_file',
          message: `Command file is empty: ${commandName}.md`,
        };
      }
      getLog().debug({ commandName, filePath }, 'command_loaded');
      return { success: true, content };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'EACCES') {
        getLog().error({ commandName, filePath }, 'command_file_permission_denied');
        return {
          success: false,
          reason: 'permission_denied',
          message: `Permission denied reading command: ${commandName}.md`,
        };
      }
      // Other unexpected errors (ENOENT shouldn't happen since the walk just found it,
      // but if the file was deleted between walk and read we fall through to 'not found'
      // with a log.)
      getLog().error({ err, commandName, filePath }, 'command_file_read_error');
      return {
        success: false,
        reason: 'read_error',
        message: `Error reading command ${commandName}.md: ${err.message}`,
      };
    }
  }

  // If not found in repo/home and app defaults enabled, search app defaults
  if (loadDefaultCommands) {
    // A captured run reads the bundled command bytes IT froze; see the note above.
    if (isBinaryBuild() && roots.kind === 'live') {
      // Binary: check bundled commands
      const bundledContent = BUNDLED_COMMANDS[commandName];
      if (bundledContent) {
        getLog().debug({ commandName }, 'command_loaded_bundled');
        return { success: true, content: bundledContent };
      }
      getLog().debug({ commandName }, 'command_bundled_not_found');
    } else {
      // Bun (or any captured run): load from the bundled-commands root, walking 1 level
      // deep so `defaults/archon-*.md` resolves.
      const appDefaultsPath = roots.bundledCommands;
      const entries = await archonPaths.findMarkdownFilesRecursive(appDefaultsPath, '', {
        maxDepth: 1,
      });
      const match = entries.find(e => e.commandName === commandName);
      if (match) {
        const filePath = join(appDefaultsPath, match.relativePath);
        try {
          const content = await readFile(filePath, 'utf-8');
          if (!content.trim()) {
            getLog().error({ commandName }, 'command_app_default_empty');
            return {
              success: false,
              reason: 'empty_file',
              message: `App default command file is empty: ${commandName}.md`,
            };
          }
          getLog().debug({ commandName }, 'command_loaded_app_defaults');
          return { success: true, content };
        } catch (error) {
          const err = error as NodeJS.ErrnoException;
          if (err.code !== 'ENOENT') {
            getLog().warn({ err, commandName }, 'command_app_default_read_error');
          } else {
            getLog().debug({ commandName }, 'command_app_default_not_found');
          }
          // Fall through to not found
        }
      } else {
        getLog().debug({ commandName }, 'command_app_default_not_found');
      }
    }
  }

  // Not found anywhere
  const allSearchPaths = loadDefaultCommands ? [...searchPaths, 'app defaults'] : searchPaths;
  getLog().error({ commandName, searchPaths: allSearchPaths }, 'command_not_found');
  return {
    success: false,
    reason: 'not_found',
    message: `Command prompt not found: ${commandName}.md (searched: ${allSearchPaths.join(', ')})`,
  };
}

// ─── Variable Substitution ───────────────────────────────────────────────────

/**
 * Scope holding the current run's adopted artifact directory (#2747), entered by
 * the executor around DAG execution. A scoped context rather than another
 * positional parameter because the value is RUN-level (like `artifactsDir`) but
 * is consumed at every substitution site several layers down; a child sub-run's
 * `executeWorkflow` re-enters with its own (absent) scope, correctly shadowing
 * the parent's adoption.
 */
const adoptedRunDirContext = new AsyncLocalStorage<string>();

export function runWithAdoptedRunDir<T>(
  adoptedRunDir: string | undefined,
  fn: () => Promise<T>
): Promise<T> {
  if (adoptedRunDir === undefined) return fn();
  return adoptedRunDirContext.run(adoptedRunDir, fn);
}

function currentAdoptedRunDir(): string | undefined {
  return adoptedRunDirContext.getStore();
}

/** Pattern string for context variables - used to create fresh regex instances */
export const CONTEXT_VAR_PATTERN_STR =
  '\\$(?:CONTEXT|EXTERNAL_CONTEXT|ISSUE_CONTEXT)(?![A-Za-z0-9_])';

/**
 * Substitute workflow variables in a prompt.
 *
 * Supported variables:
 * - $WORKFLOW_ID - The workflow run ID
 * - $USER_MESSAGE, $ARGUMENTS - The user's trigger message
 * - $ARTIFACTS_DIR - External artifacts directory for this workflow run
 * - $STATE_DIR - External per-PROJECT cross-run state directory (shared by every
 *   workflow in the project; pre-created by the executor). Throws if referenced
 *   without a resolved value.
 * - $ADOPTED_RUN_DIR (#2747) - The adopted run's artifact directory, resolved
 *   through its persisted `output_root`. Read-only by contract; throws if
 *   referenced without an adoption active.
 * - $BASE_BRANCH - The base branch (from config or auto-detected)
 * - $CONTEXT, $EXTERNAL_CONTEXT, $ISSUE_CONTEXT - GitHub issue/PR context (if available)
 * - $DOCS_DIR - Documentation directory path (configured or default 'docs/')
 * - $LOOP_USER_INPUT - User feedback from interactive loop approval. Only populated on the
 *   first iteration of a resumed interactive loop; empty string on all other iterations.
 * - $REJECTION_REASON - Reviewer feedback from approval node rejection (on_reject prompts only).
 * - $LOOP_PREV_OUTPUT - Cleaned output of the previous loop iteration. Empty string on the
 *   first iteration (no prior output exists). Useful for fresh_context loops that need
 *   to reference what the previous pass produced or why it failed.
 * - $INPUTS.<name> - Named sub-run inputs (#2470), supplied by a caller's `with:` on a
 *   `workflow:` node. Resolved from `options.inputs` in the non-shell branch only; an
 *   unknown name THROWS. Shell (bash/script) nodes read `INPUTS_<UPPER_SNAKE>` env vars.
 *
 * When issueContext is undefined, context variables are replaced with empty string
 * to avoid sending literal "$CONTEXT" to the AI.
 */
export function substituteWorkflowVariables(
  prompt: string,
  workflowId: string,
  userMessage: string,
  artifactsDir: string,
  baseBranch: string,
  docsDir: string,
  issueContext?: string,
  loopUserInput?: string,
  rejectionReason?: string,
  loopPrevOutput?: string,
  options?: {
    shellSafe?: boolean;
    stateDir?: string;
    inputs?: Record<string, JsonValue>;
    /** Adopted run's artifact directory (#2747). Undefined = no adoption active. */
    adoptedRunDir?: string;
  }
): { prompt: string; contextSubstituted: boolean } {
  // Fail fast if the prompt references $BASE_BRANCH but no base branch could be resolved
  if (!baseBranch && prompt.includes('$BASE_BRANCH')) {
    throw new Error(
      'No base branch could be resolved. Auto-detection failed and `worktree.baseBranch` is not set in .archon/config.yaml. ' +
        'Set the config value or use the --from flag to select a branch (e.g., --from dev).'
    );
  }

  // Same fail-fast for $STATE_DIR. The state directory is threaded from the
  // executor to every substitution site; a site that forgot to pass it would
  // otherwise leave the variable literal (AI nodes) or empty (shell nodes),
  // silently writing state to the wrong place. Loud beats silent.
  if (!options?.stateDir && prompt.includes('$STATE_DIR')) {
    throw new Error(
      '$STATE_DIR is referenced but no state directory was resolved for this run. ' +
        '$STATE_DIR is only available inside a workflow run; if you are seeing this from a workflow node, ' +
        'please report it as a bug.'
    );
  }

  // $ADOPTED_RUN_DIR (#2747) resolves only under an explicit adoption. A run
  // that references it without one throws — mirroring $BASE_BRANCH/$STATE_DIR —
  // because a literal or empty substitution would silently point work at
  // nothing instead of telling the author the run was never started with --adopt.
  if (!options?.adoptedRunDir && !currentAdoptedRunDir() && prompt.includes('$ADOPTED_RUN_DIR')) {
    throw new Error(
      '$ADOPTED_RUN_DIR is referenced but this run did not adopt a prior run. ' +
        'Start it with `workflow run <name> --adopt <run-id>` (or adopt_run_id on the API) ' +
        "to read an earlier run's artifacts by reference."
    );
  }

  // Defensive: ensure docsDir always has a value (callers should resolve, but guard here)
  const resolvedDocsDir = docsDir || 'docs/';

  // Substitute basic variables
  // When shellSafe is true, skip user-controlled variables — they will be passed
  // via subprocess environment variables instead to prevent shell injection.
  let result = prompt
    .replace(/\$WORKFLOW_ID/g, workflowId)
    .replace(/\$ARTIFACTS_DIR/g, artifactsDir)
    // Engine-controlled like $ARTIFACTS_DIR — substituted even under shellSafe,
    // or `bash:`/`script:` bodies would never see it.
    .replace(/\$STATE_DIR/g, options?.stateDir ?? '')
    .replace(/\$ADOPTED_RUN_DIR/g, options?.adoptedRunDir ?? currentAdoptedRunDir() ?? '')
    .replace(/\$BASE_BRANCH/g, baseBranch)
    .replace(/\$DOCS_DIR/g, resolvedDocsDir);

  if (!options?.shellSafe) {
    result = result
      .replace(/\$USER_MESSAGE/g, userMessage)
      .replace(/\$ARGUMENTS/g, userMessage)
      .replace(/\$LOOP_USER_INPUT/g, loopUserInput ?? '')
      .replace(/\$REJECTION_REASON/g, rejectionReason ?? '')
      .replace(/\$LOOP_PREV_OUTPUT/g, loopPrevOutput ?? '');

    // $INPUTS.<name> — named sub-run inputs (#2470). Substituted ONLY in the non-shell
    // branch: a sub-run's input value can derive from AI output (e.g. `with: {plan:
    // $plan.output}`), the exact user-controlled class shellSafe keeps out of shell
    // source (#2115). Bash/script bodies read INPUTS_<UPPER_SNAKE> env vars instead.
    // An unknown name THROWS (mirrors $node.output.field strictness) rather than
    // substituting '' — a typo'd input silently emptying is worse than a load-visible error.
    result = substituteInputRefs(result, options?.inputs);
  }

  // Check if context variables exist (use fresh regex to avoid lastIndex issues)
  const hasContextVariables = new RegExp(CONTEXT_VAR_PATTERN_STR).test(result);

  // Substitute or clear context variables (use fresh global regex for replace)
  if (!options?.shellSafe) {
    if (!issueContext && hasContextVariables) {
      getLog().debug(
        {
          action: 'clearing variables',
          variables: ['$CONTEXT', '$EXTERNAL_CONTEXT', '$ISSUE_CONTEXT'],
        },
        'context_variables_cleared'
      );
    }
    result = result.replace(new RegExp(CONTEXT_VAR_PATTERN_STR, 'g'), issueContext ?? '');
  }

  return {
    prompt: result,
    contextSubstituted: hasContextVariables && !!issueContext,
  };
}

/**
 * Apply variable substitution and optionally append issue context.
 * Appends context only if it wasn't already substituted via $CONTEXT variables.
 * This prevents duplicate context being sent to the AI.
 *
 * @param template - The command prompt template with variable placeholders
 * @param workflowId - The workflow run ID for variable substitution
 * @param userMessage - The user's trigger message for variable substitution
 * @param artifactsDir - The external artifacts directory for $ARTIFACTS_DIR substitution
 * @param baseBranch - The resolved base branch for $BASE_BRANCH substitution
 * @param docsDir - The resolved docs directory for $DOCS_DIR substitution
 * @param issueContext - Optional GitHub issue/PR context to substitute or append
 * @param logLabel - Human-readable label for logging (e.g., 'workflow step prompt')
 * @param options - Forwarded to {@link substituteWorkflowVariables}; carries `stateDir`
 *   for `$STATE_DIR`, which throws when referenced without one.
 * @returns The final prompt with variables substituted and context optionally appended
 */
export function buildPromptWithContext(
  template: string,
  workflowId: string,
  userMessage: string,
  artifactsDir: string,
  baseBranch: string,
  docsDir: string,
  issueContext: string | undefined,
  logLabel: string,
  options?: { shellSafe?: boolean; stateDir?: string; inputs?: Record<string, JsonValue> }
): string {
  const { prompt, contextSubstituted } = substituteWorkflowVariables(
    template,
    workflowId,
    userMessage,
    artifactsDir,
    baseBranch,
    docsDir,
    issueContext,
    undefined,
    undefined,
    undefined,
    options
  );

  if (issueContext && !contextSubstituted) {
    getLog().debug({ logLabel }, 'issue_context_appended');
    return prompt + '\n\n---\n\n' + issueContext;
  }

  return prompt;
}

// ─── Completion Signal Detection ────────────────────────────────────────────

/**
 * Escape special regex characters in string
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Detect whether the AI output contains a completion signal.
 *
 * Supports three formats, checked in order:
 * 1. <promise>SIGNAL</promise> - Recommended; prevents false positives in prose
 * 2. <anytag>SIGNAL</anytag> - Any XML-wrapped tag; case-insensitive on tag names
 * 3. Plain SIGNAL - Backwards compatibility; only at end of output or on own line
 *
 * Tag matching uses a backreference (\1) so opening and closing tag names must
 * agree — `<COMPLETE>X</done>` is not treated as a completion, which avoids
 * false positives when the AI interleaves tags in prose.
 *
 * Plain signal detection is restrictive to prevent false positives like "not SIGNAL yet".
 */
export function detectCompletionSignal(output: string, signal: string): boolean {
  // Check for XML-like tag wrapping with matching open/close names: <tag>SIGNAL</tag>.
  // Catches <promise>COMPLETE</promise>, <COMPLETE>ALL_CLEAN</COMPLETE>, <done>X</done>.
  // The `([a-zA-Z][\w-]*)` capture plus `</\1>` backreference requires tag names to match.
  const xmlWrappedPattern = new RegExp(
    `<([a-zA-Z][\\w-]*)[^>]*>\\s*${escapeRegExp(signal)}\\s*</\\1>`,
    'i'
  );
  if (xmlWrappedPattern.test(output)) {
    return true;
  }
  // Plain signal detection - restrictive to prevent false positives like "not COMPLETE yet"
  // Only matches if signal is:
  // 1. At the very end of output (with optional trailing whitespace/punctuation)
  // 2. On its own line
  const endPattern = new RegExp(`${escapeRegExp(signal)}[\\s.,;:!?]*$`);
  const ownLinePattern = new RegExp(`^\\s*${escapeRegExp(signal)}\\s*$`, 'm');
  return endPattern.test(output) || ownLinePattern.test(output);
}

/**
 * Name the completion channels a loop declared, for the max-iterations failure
 * message (#2563).
 *
 * `loop.until` became optional once `until_bash` alone could end a loop, so a
 * message hard-coding `without completion signal '<until>'` prints `undefined`
 * for a deterministic-only loop and names a channel the author never declared.
 * Both loop variants read this so they can never describe the same loop
 * differently — the divergence between them is exactly what #2563 asked to fix.
 *
 * The schema guarantees at least one channel, so the empty case is unreachable;
 * it is handled rather than asserted because this is only an error message.
 */
export function describeUnmetCompletion(control: {
  until?: string;
  until_bash?: string;
  until_field?: string;
}): string {
  const channels: string[] = [];
  if (control.until) channels.push(`completion signal '${control.until}'`);
  if (control.until_bash) channels.push("a passing 'until_bash' check");
  if (control.until_field) channels.push(`'${control.until_field}' ever being true`);
  if (channels.length === 0) return 'without a completion channel';
  return `without ${channels.join(' or ')}`;
}

/**
 * Strip internal completion signal tags before sending to user-facing output.
 * Always strips `<promise>…</promise>` (any content). When `until` is provided,
 * also strips any XML-wrapped form of that signal with matching tag names
 * (e.g. `<COMPLETE>ALL_CLEAN</COMPLETE>`). Mismatched tag names are left alone
 * so regular prose (`<note>ALL_CLEAN</warning>`) isn't accidentally rewritten.
 */
export function stripCompletionTags(content: string, until?: string): string {
  let result = content.replace(/<promise>[\s\S]*?<\/promise>/gi, '');
  if (until) {
    // Strip XML-tagged completion signals with matching open/close tag names.
    const escapedSignal = escapeRegExp(until);
    result = result.replace(
      new RegExp(`<([a-zA-Z][\\w-]*)[^>]*>\\s*${escapedSignal}\\s*</\\1>`, 'gi'),
      ''
    );
  }
  return result.trim();
}

/**
 * Determine whether a script string is "inline" code or a named script reference.
 * A named script is a simple identifier (no newlines, no whitespace, no shell metacharacters).
 * Used by both the DAG executor (runtime dispatch) and the validator (resource checks).
 */
export function isInlineScript(script: string): boolean {
  return script.includes('\n') || /[;(){}&|<>$`"' ]/.test(script);
}

// ─── Platform Message Sending ────────────────────────────────────────────────

/** Context for platform message sending */
export interface SendMessageContext {
  workflowId?: string;
  nodeName?: string;
}

/** Threshold for consecutive UNKNOWN errors before aborting */
const UNKNOWN_ERROR_THRESHOLD = 3;

/** Mutable counter for tracking consecutive unknown errors across calls */
export interface UnknownErrorTracker {
  count: number;
}

/**
 * Safely send a message to the platform without crashing on failure.
 * Returns true if message was sent successfully, false otherwise.
 * Only suppresses transient/unknown errors; fatal errors are rethrown.
 * When unknownErrorTracker is provided, consecutive UNKNOWN errors are tracked
 * and the workflow is aborted after UNKNOWN_ERROR_THRESHOLD consecutive failures.
 */
export async function safeSendMessage(
  platform: IWorkflowPlatform,
  conversationId: string,
  message: string,
  context?: SendMessageContext,
  metadata?: WorkflowMessageMetadata,
  unknownErrorTracker?: UnknownErrorTracker
): Promise<boolean> {
  try {
    await platform.sendMessage(conversationId, message, metadata);
    if (unknownErrorTracker) unknownErrorTracker.count = 0;
    return true;
  } catch (error) {
    const err = error as Error;
    const errorType = classifyError(err);

    getLog().error(
      {
        err,
        conversationId,
        messageLength: message.length,
        errorType,
        platformType: platform.getPlatformType(),
        ...context,
        stack: err.stack,
      },
      'platform_message_send_failed'
    );

    // Reset tracker on any non-UNKNOWN outcome — only *consecutive* UNKNOWN
    // errors should trip the threshold (e.g. UNKNOWN→TRANSIENT→UNKNOWN→UNKNOWN
    // is two separate runs, not three in a row).
    if (unknownErrorTracker && errorType !== 'UNKNOWN') {
      unknownErrorTracker.count = 0;
    }

    // Fatal errors should not be suppressed - they indicate configuration issues
    if (errorType === 'FATAL') {
      throw new Error(`Platform authentication/permission error: ${err.message}`);
    }

    // Track consecutive UNKNOWN errors - abort if threshold exceeded
    if (errorType === 'UNKNOWN' && unknownErrorTracker) {
      unknownErrorTracker.count++;
      if (unknownErrorTracker.count >= UNKNOWN_ERROR_THRESHOLD) {
        throw new Error(
          `${String(UNKNOWN_ERROR_THRESHOLD)} consecutive unrecognized errors - aborting workflow: ${err.message}`
        );
      }
    }

    // Transient errors (and below-threshold unknown errors) suppressed to allow workflow to continue
    return false;
  }
}
