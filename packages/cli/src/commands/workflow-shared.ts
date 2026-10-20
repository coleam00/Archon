/**
 * Helpers shared by the `archon workflow` command modules: the logger, run options,
 * run destination, run-id resolution and the CLI's refusal spelling.
 */
import { WORKFLOW_CODEBASE_ID_ENV } from '@archon/paths/workflow-scope';

import type { Conversation } from '@archon/core/schemas/conversation';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { findCodebaseForCheckoutPath } from '@archon/core/services/codebase-checkout-resolver';
import {
  ChildRunRedirectError,
  workflowOperationErrorMessage,
} from '@archon/core/operations/workflow-operations';
import * as archonPaths from '@archon/paths';
import { createLogger } from '@archon/paths';
import type { WorkflowResumeCursor } from '@archon/workflows/store';
import type { WorkflowRunConfigInput } from '@archon/workflows/schemas/run-config';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { generateConversationId } from '../utils/conversation-id';
import { CLI_WORKFLOW_SURFACE } from '../utils/workflow-surface';
import { writeJsonLine } from '../utils/stdout';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
export function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli.workflow');
  return cachedLog;
}

/**
 * Options for workflow run command
 *
 * Default: creates worktree with auto-generated branch name (isolation by default).
 * --branch: explicit branch name for the worktree.
 * --no-worktree: opt out of isolation, run in live checkout.
 * --resume: reuse worktree from last failed run.
 * --from: override base branch (start-point for worktree).
 * --base: per-dispatch PR base + worktree cut-from override (wins over config).
 *
 * Mutually exclusive: --branch + --no-worktree, --resume + --branch,
 * --base + --no-worktree.
 */
export interface WorkflowRunOptions {
  branchName?: string;
  fromBranch?: string;
  /**
   * Per-dispatch base-branch override (`--base <branch>`). Wins over repo config
   * and the codebase default for BOTH the worktree cut-from and the PR target
   * (`$BASE_BRANCH`). Mutually exclusive with `--no-worktree`.
   */
  baseBranch?: string;
  registrationBaseBranch?: string;
  noWorktree?: boolean;
  /**
   * Register the supplied directory as a folder project and run in place,
   * even with git. Reuses existing folder registrations; refuses existing repos.
   */
  folder?: boolean;
  /**
   * Run a FOLDER project inside the container isolation backend instead of
   * in-place. Flag beats workflow `container.enabled`, which beats config
   * `container.enabled` (default off). A repo-kind project + `--container` is a
   * hard error (container isolation is folder-only in v1).
   */
  container?: boolean;
  resume?: boolean;
  codebaseId?: string; // Skips path-based codebase lookup when resume/approve/reject already resolved it
  /**
   * Override the directory used for workflow YAML discovery — and, for a fresh run,
   * the source the run captures.
   *
   * Pass `codebase.default_cwd` here so the source repo is searched even when
   * `working_path` is a worktree or workspace clone that lacks the file. The public
   * `--workflow-source <path>` flag sets the same field, which is why one concept
   * covers both the internal resume/approve lookups and the user-facing split.
   */
  discoveryCwd?: string;
  /**
   * The run being continued, when this invocation continues one.
   *
   * Resume, approve, and reject re-enter through this command, and they must execute the
   * source the run FROZE — a workflow that lives only in the authoring checkout is not in
   * the target at all, and even when it is, re-discovering live resumes the run against a
   * different graph. The whole run is passed, not just its capture path, because
   * `resolveContinuationWorkflow` needs the recorded digest to verify against.
   *
   * Optional because `run <name> --resume` names the run indirectly; that form resolves the
   * row itself, before discovery, and joins the same path. `resume` alone therefore never
   * means live discovery.
   */
  continuationRun?: WorkflowRun;
  continuationCursor?: WorkflowResumeCursor;
  quiet?: boolean;
  verbose?: boolean;
  /** Platform conversation ID (e.g. `cli-{ts}-{rand}`), NOT a DB UUID. */
  conversationId?: string;
  /**
   * Run the workflow in a detached background child and return immediately.
   * The parent creates a queryable pending run and pins its branch on the child's
   * argv. The child executes that run and owns its source capture and worktree.
   */
  detach?: boolean;
  /**
   * Emit a machine-readable JSON ack for the spawned child instead of human
   * text. Only meaningful together with `detach`: without `detach` a foreground
   * `workflow run` streams human output and has no JSON ack to emit (passing
   * `--json` alone still suppresses CLI logs but does not change the output).
   */
  json?: boolean;
  /** Simulate deterministic DAG control flow without creating run state or contacting a provider. */
  dryRun?: boolean;
  /** YAML mapping of node ids to scalar or structured simulated outputs. */
  stubsPath?: string;
  /** Write a complete YAML stub scaffold for the discovered workflow and exit. */
  stubsInitPath?: string;
  /** Fill reached nodes missing from the supplied stub map with validated placeholders. */
  defaultStubs?: boolean;
  /** Execute reachable bash/script nodes locally instead of requiring stubs. */
  execCode?: boolean;
  /** Stop at the first approval gate instead of auto-approving it. */
  pauseAtGates?: boolean;
  /**
   * Raw `--input name=value` assignments (#2554), one per occurrence of the flag.
   * Parsed and validated against the workflow's declared `inputs:` at the invocation
   * gate — before the `--detach` fork and before any worktree, clone, or AI cost.
   * Kept as raw strings here so the grammar has exactly one parser
   * (`parseInputAssignments` in `@archon/workflows`).
   */
  inputs?: string[];
  /** Raw repeatable `--model name=spec` mappings; parsed once at the invocation gate. */
  modelAssignments?: string[];
  /** Local YAML file supplying a sparse configuration layer for this run. */
  configPath?: string;
  /**
   * `--config-from-run <id>`: start with the run config that run was started with, so a
   * continuation launched for a paused run keeps its provider configuration. Exclusive
   * with `configPath`.
   */
  configFromRun?: string;
  /** @internal Structurally validated immutable layer transferred from a detached parent. */
  detachedRunConfig?: WorkflowRunConfigInput;
  /**
   * @internal The run row the detached parent created before forking (#2872). Present
   * only on a FRESH detached launch: the child executes this row instead of creating
   * its own, which is what lets the parent's ack hand back a run id whose row already
   * exists. A continuation carries its own run and never sets it.
   */
  detachedRunId?: string;
  /**
   * Between-run continuation (#2747): adopt a terminal run's estate — its
   * worktree/branch plus read access to its artifacts via `$ADOPTED_RUN_DIR`.
   * Run-id only, never a name (#2645): newest-wins selection is the ambiguity
   * class this flag must not introduce.
   */
  adoptRunId?: string;
  /**
   * Between-run continuation (#2747): record that this fresh-lane run replaces
   * the prior run's open item, closing its inbox row through the same
   * no-adopter query. Provenance only — NO lane inheritance.
   */
  supersedesRunId?: string;
}

export type RunDestination =
  | { kind: 'conversation'; conversation: Conversation }
  | { kind: 'headless'; correlationId: string };

export function destinationCorrelationId(destination: RunDestination): string {
  return destination.kind === 'conversation'
    ? destination.conversation.platform_conversation_id
    : destination.correlationId;
}

// Transport correlation never creates chat provenance. Only a continued run's stored
// origin can attach a recorder; losing that destination must refuse the continuation.
export async function resolveRunDestination(
  host: WorkflowHost,
  options: WorkflowRunOptions,
  continuationRun: WorkflowRun | undefined
): Promise<RunDestination> {
  if (continuationRun !== undefined) {
    const storedConversationId =
      continuationRun.conversation_id ?? continuationRun.parent_conversation_id;
    if (storedConversationId === null)
      return { kind: 'headless', correlationId: continuationRun.id };
    let conversation;
    try {
      conversation = await host.records.conversations.getConversationById(storedConversationId);
    } catch (error) {
      getLog().error(
        {
          err: error as Error,
          runId: continuationRun.id,
          conversationId: storedConversationId,
        },
        'cli.workflow_continuation_conversation_lookup_failed'
      );
      throw new Error(
        `Failed to load conversation '${storedConversationId}' for workflow run '${continuationRun.id}': ${(error as Error).message}\n` +
          'The run was not resumed. Fix the conversation lookup problem, then retry.'
      );
    }
    if (!conversation) {
      getLog().error(
        { runId: continuationRun.id, conversationId: storedConversationId },
        'cli.workflow_continuation_conversation_not_found'
      );
      throw new Error(
        `Conversation '${storedConversationId}' for workflow run '${continuationRun.id}' no longer exists.\n` +
          'The run was not resumed. Restore the conversation, then retry.'
      );
    }
    return { kind: 'conversation', conversation };
  }
  return { kind: 'headless', correlationId: options.conversationId ?? generateConversationId() };
}

/**
 * Format age of a run from started_at to now.
 */
export function formatAge(startedAt: Date | string): string {
  const date = new Date(startedAt);
  if (Number.isNaN(date.getTime())) return 'unknown';
  const ms = Date.now() - date.getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export async function resolveRunTranscriptPath(
  host: WorkflowHost,
  run: WorkflowRun
): Promise<string | null> {
  const codebase = run.codebase_id
    ? await host.records.codebases.getCodebase(run.codebase_id)
    : null;
  const root = archonPaths.resolveRunStorageRoot(run, codebase);
  return root ? archonPaths.getRunLogPathForRoot(root, run.id) : null;
}

/**
 * How this surface states a refusal. Core keeps a child-run redirect free of any command
 * spelling, so the command is written here, where `archon workflow …` is what the operator
 * can actually type.
 */
function cliRefusalText(error: unknown): string {
  return workflowOperationErrorMessage(error, CLI_WORKFLOW_SURFACE);
}

/**
 * Run a gate operation, re-throwing a child-run redirect with this surface's spelling.
 * The human path reports an error by propagating it, so the spelling has to be attached
 * before it leaves. Every other error passes through untouched, keeping the type the exit
 * code is derived from.
 */
export async function spelledForCli<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (error) {
    if (error instanceof ChildRunRedirectError) {
      throw new Error(cliRefusalText(error), { cause: error });
    }
    throw error;
  }
}

export function printJsonWriteError(runId: string, action: string, error: unknown): Promise<void> {
  return writeJsonLine({ ok: false, runId, action, error: cliRefusalText(error) });
}

/**
 * Matches a full run id: a dashed UUID (Postgres `gen_random_uuid()`) or 32
 * undashed hex chars (SQLite `hex(randomblob(16))`). Anything shorter is
 * treated as a prefix.
 */
const FULL_RUN_ID_RE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;

export async function inheritedWorkflowCodebase(host: WorkflowHost, all?: boolean) {
  const scope = process.env[WORKFLOW_CODEBASE_ID_ENV];
  if (scope === undefined) return undefined;
  if (all) throw new Error('--all cannot override the selected chat project.');
  const codebase = scope ? await host.records.codebases.getCodebase(scope) : null;
  if (!codebase) throw new Error(`${WORKFLOW_CODEBASE_ID_ENV} must name a registered project.`);
  return codebase;
}

/**
 * Resolve a run-id argument that may be the 8-char short id printed by
 * `workflow runs` into the full run id. Mirrors the chat `manage_run` tool's
 * prefix resolution (getScopedRun): the lookup is scoped to the cwd's
 * codebase, a unique match resolves, and an ambiguous prefix errors.
 *
 * ARCHON_WORKFLOW_CODEBASE_ID requires a unique project-scoped match for every ID.
 * Without that explicit scope, full UUIDs skip resolution entirely: exact lookup
 * is global, so full ids keep working from any directory. A caller that already resolved a project can
 * provide its id; otherwise project lookup preserves an exact checkout
 * registration, then falls back to a linked worktree's canonical checkout. By
 * default, an omitted or unregistered cwd and an unmatched prefix pass through
 * unchanged so the downstream exact lookup keeps its existing error surface.
 * Callers without a downstream lookup can require a match instead.
 */
export async function resolveRunIdArg(
  host: WorkflowHost,
  runId: string,
  cwd?: string,
  requirePrefixMatch = false,
  codebaseId?: string
): Promise<string> {
  const scope = process.env[WORKFLOW_CODEBASE_ID_ENV];
  if (scope !== undefined) return resolveProjectScopedRunId(host, runId, scope);
  if (FULL_RUN_ID_RE.test(runId)) return runId;
  if (cwd === undefined && codebaseId === undefined) {
    if (requirePrefixMatch) {
      throw new Error(`Cannot resolve run id prefix '${runId}' without a project directory.`);
    }
    return runId;
  }
  const resolvedCodebaseId =
    codebaseId ??
    (cwd === undefined
      ? undefined
      : (await findCodebaseForCheckoutPath(cwd, host.records.codebases))?.id);
  if (!resolvedCodebaseId) {
    if (requirePrefixMatch) {
      throw new Error(`Cannot resolve run id prefix '${runId}' outside a registered project.`);
    }
    return runId;
  }
  const matches = await host.deps.store.findWorkflowRunsByIdPrefix(runId, resolvedCodebaseId);
  if (matches.length > 1) {
    const candidates = matches.map(match => `  ${match.id}`).join('\n');
    throw new Error(
      `Run id '${runId}' matches more than one run in this project:\n${candidates}\nUse more characters or the full id.`
    );
  }
  if (matches.length === 0) {
    if (requirePrefixMatch) {
      throw new Error(`No workflow run matches prefix '${runId}' in this project.`);
    }
    return runId;
  }
  return matches[0].id;
}

async function resolveProjectScopedRunId(
  host: WorkflowHost,
  runId: string,
  codebaseId: string
): Promise<string> {
  if (!codebaseId) throw new Error(`${WORKFLOW_CODEBASE_ID_ENV} must name a registered project.`);
  const matches = await host.deps.store.findWorkflowRunsByIdPrefix(runId, codebaseId);
  if (
    matches.length !== 1 ||
    (FULL_RUN_ID_RE.test(runId) && matches[0]?.id.toLowerCase() !== runId.toLowerCase())
  ) {
    throw new Error(`Run id '${runId}' does not identify exactly one run in the selected project.`);
  }
  return matches[0].id;
}

export async function resolveDiscoveryCwdForCodebase(
  host: WorkflowHost,
  runId: string,
  codebaseId: string,
  action: 'resume' | 'approve' | 'reject' | 'respond' | 'answer'
): Promise<string> {
  try {
    const codebase = await host.records.codebases.getCodebase(codebaseId);
    if (!codebase) {
      throw new Error(
        `Workflow run '${runId}' references codebase '${codebaseId}', but that codebase no longer exists.\n` +
          'Cannot safely discover workflows from the run worktree because project workflow files may be missing.\n' +
          'Re-register the project or restore the codebase row, then retry.'
      );
    }
    return codebase.default_cwd;
  } catch (error) {
    const err = error as Error;
    if (err.message.includes('references codebase')) {
      throw err;
    }
    getLog().error(
      { err, errorType: err.constructor.name, runId, codebaseId },
      `cli.workflow_${action}_codebase_lookup_failed`
    );
    throw new Error(
      `Failed to load codebase '${codebaseId}' for workflow run '${runId}': ${err.message}\n` +
        'Cannot safely discover workflows from the run worktree because project workflow files may be missing.\n' +
        'Fix the codebase lookup problem, then retry.'
    );
  }
}
