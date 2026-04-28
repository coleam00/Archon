/**
 * Shared helpers for executor.ts and dag-executor.ts.
 *
 * Extracted here once the Rule of Three was met — both files had
 * identical copies of these error-classification and prompt-building
 * utilities. Single source of truth; no logic changes from either copy.
 */
import { readFile } from 'fs/promises';
import { join } from 'path';
import type { WorkflowDeps } from './deps';
import * as archonPaths from '@archon/paths';
import { BUNDLED_COMMANDS, isBinaryBuild } from './defaults/bundled-defaults';
import { createLogger } from '@archon/paths';
import { isValidCommandName } from './command-validation';
import type { LoadCommandResult } from './schemas';

/** Lazy-initialized logger */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.executor-shared');
  return cachedLog;
}

// ─── Error Classification ────────────────────────────────────────────────────

/** Result of error classification */
export type ErrorType = 'TRANSIENT' | 'FATAL' | 'UNKNOWN';

/** Fatal error patterns - authentication/authorization issues that won't resolve with retry */
export const FATAL_PATTERNS = [
  'unauthorized',
  'forbidden',
  'invalid token',
  'authentication failed',
  'permission denied',
  '401',
  '403',
  'credit balance',
  'auth error',
];

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
  'network error',
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
 * FATAL patterns take priority over TRANSIENT patterns to prevent an error message
 * containing both (e.g. "unauthorized: process exited with code 1") from being retried.
 */
export function classifyError(error: Error): ErrorType {
  const message = error.message.toLowerCase();

  if (matchesPattern(message, FATAL_PATTERNS)) {
    return 'FATAL';
  }
  if (matchesPattern(message, TRANSIENT_PATTERNS)) {
    return 'TRANSIENT';
  }
  return 'UNKNOWN';
}

// ─── Subprocess Failure Formatting ───────────────────────────────────────────

/** Max characters of stderr/message we keep in user-facing and logged fields. */
const SUBPROCESS_ERROR_MAX_CHARS = 2000;

/**
 * Raw ExecFileException shape from Node's `child_process.execFile` (via
 * `promisify`). `err.message` is always `"Command failed: <cmd> <args>\n<stderr>"` —
 * for inline scripts via `bash -c <body>` / `bun -e <body>` the entire script body
 * is embedded in `err.message`, `err.cmd`, and the first line of `err.stack`.
 */
export interface RawSubprocessError {
  message?: string;
  stderr?: string;
  stdout?: string;
  code?: number | string;
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

  // Strip "Command failed: <cmd line>\n" prefix if present. The first line of
  // Node's ExecFileException.message contains the entire command line — including
  // the full substituted script body for `bash -c <body>` / `bun -e <body>`.
  // We never want that line in user-facing output; fall back to a generic label
  // rather than re-leaking it.
  const hasCommandFailedPrefix = rawMessage.startsWith('Command failed:');
  const bodyAfterPrefix = hasCommandFailedPrefix
    ? rawMessage.split('\n').slice(1).join('\n').trim()
    : rawMessage;

  const diagnostic =
    stderr ||
    bodyAfterPrefix ||
    (hasCommandFailedPrefix ? 'no diagnostic output' : rawMessage) ||
    'unknown error';
  const truncated =
    diagnostic.length > SUBPROCESS_ERROR_MAX_CHARS
      ? diagnostic.slice(-SUBPROCESS_ERROR_MAX_CHARS) + '\n…[truncated]'
      : diagnostic;

  const exitSuffix =
    typeof err.code === 'number' || typeof err.code === 'string'
      ? ` [exit ${String(err.code)}]`
      : '';

  const stderrTail =
    stderr.length > SUBPROCESS_ERROR_MAX_CHARS ? stderr.slice(-SUBPROCESS_ERROR_MAX_CHARS) : stderr;

  return {
    userMessage: `${label} failed${exitSuffix}: ${truncated}`,
    logFields: {
      exitCode: err.code,
      killed: err.killed === true,
      stderrTail: stderrTail || undefined,
    },
  };
}

// ─── Credit Exhaustion Detection ────────────────────────────────────────────

/** Patterns that indicate credit/quota exhaustion in streamed assistant output */
const CREDIT_EXHAUSTION_OUTPUT_PATTERNS = [
  "you're out of extra usage",
  'out of credits',
  'credit balance',
  'insufficient credit',
];

/**
 * Detect credit exhaustion in streamed node output text.
 *
 * The Claude SDK returns credit exhaustion as a normal assistant text message
 * rather than throwing. This function checks the accumulated output for known
 * credit exhaustion phrases.
 */
export function detectCreditExhaustion(text: string): string | null {
  const lower = text.toLowerCase();
  if (CREDIT_EXHAUSTION_OUTPUT_PATTERNS.some(p => lower.includes(p))) {
    return 'Credit exhaustion detected — resume when credits reset';
  }
  return null;
}

// ─── Command Loading ─────────────────────────────────────────────────────────

/**
 * Load command prompt from file.
 *
 * @param deps - Workflow dependencies (for config loading)
 * @param cwd - Working directory (repo root)
 * @param commandName - Name of the command (without .md extension)
 * @param configuredFolder - Optional additional folder from config to search
 * @returns On success: `{ success: true, content }`. On failure: `{ success: false, reason, message }`.
 */
export async function loadCommandPrompt(
  deps: WorkflowDeps,
  cwd: string,
  commandName: string,
  configuredFolder?: string
): Promise<LoadCommandResult> {
  // Validate command name first
  if (!isValidCommandName(commandName)) {
    getLog().error({ commandName }, 'invalid_command_name');
    return {
      success: false,
      reason: 'invalid_name',
      message: `Invalid command name (potential path traversal): ${commandName}`,
    };
  }

  // Load config to check opt-out
  let config;
  try {
    config = await deps.loadConfig(cwd);
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
    config = { defaults: { loadDefaultCommands: true } };
  }

  // Use command folder paths with optional configured folder.
  // Each scope is walked 1 subfolder deep so `triage/review.md` resolves as
  // `review` — matching the workflows/scripts convention. Resolution
  // precedence: repo > home (~/.archon/commands/) > bundled/app defaults.
  const searchPaths = archonPaths.getCommandFolderSearchPaths(configuredFolder);
  const resolvedSearchPaths: string[] = [
    ...searchPaths.map(folder => join(cwd, folder)),
    archonPaths.getHomeCommandsPath(),
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
  const loadDefaultCommands = config.defaults?.loadDefaultCommands ?? true;
  if (loadDefaultCommands) {
    if (isBinaryBuild()) {
      // Binary: check bundled commands
      const bundledContent = BUNDLED_COMMANDS[commandName];
      if (bundledContent) {
        getLog().debug({ commandName }, 'command_loaded_bundled');
        return { success: true, content: bundledContent };
      }
      getLog().debug({ commandName }, 'command_bundled_not_found');
    } else {
      // Bun: load from filesystem (walk 1 level deep so `defaults/archon-*.md` resolves)
      const appDefaultsPath = archonPaths.getDefaultCommandsPath();
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
 * - $BASE_BRANCH - The base branch (from config or auto-detected)
 * - $CONTEXT, $EXTERNAL_CONTEXT, $ISSUE_CONTEXT - GitHub issue/PR context (if available)
 * - $DOCS_DIR - Documentation directory path (configured or default 'docs/')
 * - $LOOP_USER_INPUT - User feedback from interactive loop approval. Only populated on the
 *   first iteration of a resumed interactive loop; empty string on all other iterations.
 * - $REJECTION_REASON - Reviewer feedback from approval node rejection (on_reject prompts only).
 * - $LOOP_PREV_OUTPUT - Cleaned output of the previous loop iteration. Empty string on the
 *   first iteration (no prior output exists). Useful for fresh_context loops that need
 *   to reference what the previous pass produced or why it failed.
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
  loopPrevOutput?: string
): { prompt: string; contextSubstituted: boolean } {
  // Fail fast if the prompt references $BASE_BRANCH but no base branch could be resolved
  if (!baseBranch && prompt.includes('$BASE_BRANCH')) {
    throw new Error(
      'No base branch could be resolved. Auto-detection failed and `worktree.baseBranch` is not set in .archon/config.yaml. ' +
        'Set the config value or use the --from flag to select a branch (e.g., --from dev).'
    );
  }

  // Defensive: ensure docsDir always has a value (callers should resolve, but guard here)
  const resolvedDocsDir = docsDir || 'docs/';

  // Substitute basic variables
  let result = prompt
    .replace(/\$WORKFLOW_ID/g, workflowId)
    .replace(/\$USER_MESSAGE/g, userMessage)
    .replace(/\$ARGUMENTS/g, userMessage)
    .replace(/\$ARTIFACTS_DIR/g, artifactsDir)
    .replace(/\$BASE_BRANCH/g, baseBranch)
    .replace(/\$DOCS_DIR/g, resolvedDocsDir)
    .replace(/\$LOOP_USER_INPUT/g, loopUserInput ?? '')
    .replace(/\$REJECTION_REASON/g, rejectionReason ?? '')
    .replace(/\$LOOP_PREV_OUTPUT/g, loopPrevOutput ?? '');

  // Check if context variables exist (use fresh regex to avoid lastIndex issues)
  const hasContextVariables = new RegExp(CONTEXT_VAR_PATTERN_STR).test(result);

  // Substitute or clear context variables (use fresh global regex for replace)
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
  logLabel: string
): string {
  const { prompt, contextSubstituted } = substituteWorkflowVariables(
    template,
    workflowId,
    userMessage,
    artifactsDir,
    baseBranch,
    docsDir,
    issueContext
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
