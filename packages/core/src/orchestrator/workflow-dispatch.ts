/**
 * Chat workflow dispatch: starting, resuming and continuing workflow runs on
 * behalf of a conversation. `handleMessage` in orchestrator-agent.ts stays the
 * public entry and calls in here.
 */
import { recordWorktreeAdoption } from '@archon/isolation';
import {
  createRunWorktreeSetupExecutor,
  recordSetupRunSource,
  retainSetupRunSource,
} from '../workflows/worktree-setup';
import { RUN_AI_CONFIGURATION_METADATA_KEY } from '@archon/workflows/run-ai-configuration';
import { WORKFLOW_RUN_CONFIG_METADATA_KEY } from '@archon/workflows/run-config';
import {
  SUBRUN_METADATA_KEYS,
  CONTINUATION_METADATA_KEY,
} from '@archon/workflows/schemas/workflow-run';
import * as sqlIsolation from '@archon/core/db/isolation-environments';
import * as sqlWorkflow from '@archon/core/db/workflows';
import { providerRegistry } from '@archon/providers';
import { createSqlWorkflowOperations } from '../workflows/sql-host';
import { RunActionForbiddenError, type RunActor } from '../operations/run-authorization';
import { withBranchLaunchSource } from '../workflows/branch-launch-source';
import { prepareRunAiConfiguration, assertRunCredentials } from '@archon/workflows/run-preflight';
import { randomUUID } from 'node:crypto';
import type {
  IPlatformAdapter,
  HandleMessageContext,
  Conversation,
  Codebase,
  WorkflowRequest,
} from '../types';
import * as db from '../db/conversations';
import * as codebaseDb from '../db/codebases';
import { toError } from '../utils/error';
import { resolveWorkflowSourceRoot } from '../utils/workflow-source-root';
import { toRepoPath, toWorktreePath, verifyWorktreeOwnership } from '@archon/git';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { resolveWorkflowName } from '@archon/workflows/router';
import {
  withCapturedSource,
  type CapturedSourceOwner,
  prepareWorkflowSource,
  recordSelectedWorkflow,
  type PreparedWorkflowSource,
} from '@archon/workflows/run-source';
import { inspectResumableRun } from '@archon/workflows/run-resume';
import { InProcessWorkflowEngine } from '@archon/workflows/in-process-engine';
import type { WorkflowResumeAdmission } from '@archon/workflows/engine-port';
import {
  TerminalStatusWriteError,
  requireTerminalStatusWrite,
} from '@archon/workflows/terminal-status-write';
import {
  assertWorkflowRequirementsMet,
  WorkflowRequirementError,
  resolveTopLevelInputs,
  WorkflowMissingInputsError,
} from '@archon/workflows/utils/workflow-requirements';
import { WorkflowInputContractError } from '@archon/workflows/workflow-inputs';
import { formatDeprecationNotice } from '@archon/workflows/deprecation';
import type { ResolvedWorkflow, WorkflowSource } from '@archon/workflows/schemas/workflow';
import { isWorkflowWaitContext } from '@archon/workflows/schemas/workflow-run';
import type { OwnedWorktree, WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { spellWorkflowCommand, type WorkflowCommandSurface } from '@archon/workflows/deps';
import type { WorkflowRunConfigInput } from '@archon/workflows/schemas/run-config';
import { isPerUserGitHubEnabled } from '../github-auth/config';
import { getDecryptedAccessToken } from '../db/user-github-token-store';
import { createWorkflowDeps } from '../workflows/store-adapter';
import { resolveRunWorkflow } from '../workflows/resolve-run-workflow';
import { createCodebaseChildResolver } from '../workflows/child-isolation-resolver';
import {
  resolveRegisteredWorktree,
  resolveWorkflowAdoption,
  WorkflowAdoptionError,
} from '../operations/workflow-adoption';
import { loadConfig } from '../config/config-loader';
import { startRunLiveOwner, withRunLiveOwner } from '../services/run-live-owner';
import { validateAndResolveIsolation, dispatchBackgroundWorkflow } from './orchestrator';
import { IsolationBlockedError } from '@archon/isolation';
import { getLog } from './agent-log';
import * as workflowDb from '../db/workflows';
import { type RunModelOverrides } from '@archon/workflows/model-validation';

export interface WorkflowDispatchOptions {
  /**
   * Declared inputs supplied by the caller (#2554): the run route's
   * `HandleMessageContext.workflowInputs`, or the chat agent's `invoke_workflow` launch.
   * Validated at the dispatch gate before any worktree/clone/AI cost.
   */
  inputs?: Readonly<Record<string, string>>;
  /** Sparse tier/@alias rebindings supplied by this run invocation (#2481). */
  modelOverrides?: RunModelOverrides;
  /** Validated sparse config content supplied by a fresh HTTP invocation. */
  runConfig?: WorkflowRunConfigInput;
  /** Between-run continuation (#2747): adopt/supersede target, if declared. */
  adoptRunId?: string;
  supersedesRunId?: string;
}

const FAILED_RUN_PROMPT_PREVIEW_MAX = 160;

function escapeWorkflowCommandArg(value: string): string {
  return value.replace(/[\\"`]/g, '\\$&');
}

function formatPriorRunPromptPreview(message: string | null): string {
  const normalized = (message ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '(no message stored)';
  }
  if (normalized.length <= FAILED_RUN_PROMPT_PREVIEW_MAX) {
    return normalized;
  }
  return `${normalized.slice(0, FAILED_RUN_PROMPT_PREVIEW_MAX)}…`;
}

function formatResumableRunState(status: WorkflowRun['status']): string {
  return status === 'running' ? 'interrupted' : status;
}

function buildFailedRunResumePrompt(
  surface: WorkflowCommandSurface,
  workflowName: string,
  resumableRun: WorkflowRun,
  userMessage: string
): string {
  const escapedMessage = escapeWorkflowCommandArg(userMessage);
  const run = `run ${workflowName}`;
  const priorPreview = formatPriorRunPromptPreview(resumableRun.user_message);
  // This prompt fires for any non-paused resumable run — that includes a stale
  // 'running' orphan (started but never finished), not only 'failed' runs, so
  // the wording must track the actual status rather than hardcoding "failed".
  const stateLabel = formatResumableRunState(resumableRun.status);

  return [
    '---',
    '',
    `Found a prior ${stateLabel} run of **${workflowName}** (run \`${resumableRun.id}\`).`,
    '',
    '**Run prompt was:**',
    '',
    `> ${priorPreview}`,
    '',
    '---',
    '',
    '**Choose how to proceed:**',
    '',
    '**1. Resume that run** (re-runs the prompt shown above, not your current message):',
    '```',
    spellWorkflowCommand(surface, `resume ${resumableRun.id}`),
    '```',
    '',
    `**2. Discard the ${stateLabel} run, then start fresh with your current message:**`,
    '```',
    spellWorkflowCommand(surface, `abandon ${resumableRun.id}`),
    '```',
    'then re-run your command:',
    '```',
    spellWorkflowCommand(surface, `${run} "${escapedMessage}"`),
    '```',
    '',
    `**3. Start fresh with your current message, leave the ${stateLabel} run as-is** (skips the resume check):`,
    '```',
    spellWorkflowCommand(surface, `${run} --force "${escapedMessage}"`),
    '```',
  ].join('\n');
}

/** The values one dispatch reads everywhere and nothing reassigns. */
interface DispatchScope {
  readonly owner: CapturedSourceOwner;
  readonly platform: IPlatformAdapter;
  readonly conversationId: string;
  readonly conversation: Conversation;
  readonly codebase: Codebase;
  readonly actor: RunActor;
  readonly userId: string | undefined;
  readonly isolationHints: HandleMessageContext['isolationHints'] | undefined;
  readonly source: WorkflowSource | undefined;
  readonly options: WorkflowDispatchOptions | undefined;
  readonly userMessage: string;
  readonly parseWarnings: readonly string[] | undefined;
  readonly runCwd: string;
  readonly codebaseBaseBranch: string | undefined;
  readonly resolveChildIsolation: ReturnType<typeof createCodebaseChildResolver>;
}

type CapturedSource = { preparedSource: PreparedWorkflowSource; workflow: ResolvedWorkflow };
type DispatchAdoption = Awaited<ReturnType<typeof resolveWorkflowAdoption>>;
type AdoptedEnvironment = NonNullable<Awaited<ReturnType<typeof resolveRegisteredWorktree>>>;
type PreparedAiConfiguration = Awaited<ReturnType<typeof prepareRunAiConfiguration>>;

/**
 * Dispatch a workflow after the orchestrator resolves a project.
 * Auto-attaches the project to the conversation, resolves isolation, and executes.
 *
 * TODO(#988): Move to operations/ once dispatchBackgroundWorkflow is extracted
 * from the orchestrator (currently coupled to SSE bridging infrastructure).
 */
async function dispatchOrchestratorWorkflowOwned(
  owner: CapturedSourceOwner,
  platform: IPlatformAdapter,
  conversationId: string,
  conversation: Conversation,
  codebase: Codebase,
  request: WorkflowRequest,
  actor: RunActor,
  isolationHints?: HandleMessageContext['isolationHints'],
  /**
   * Discovery source of the workflow — telemetry only (bundled workflows
   * report their real name, custom ones report "custom"). Optional: callers
   * that don't have it readily in scope omit it and the run reports "custom".
   */
  source?: WorkflowSource,
  options?: WorkflowDispatchOptions
): Promise<void> {
  const userId = actor.kind === 'user' ? actor.userId : undefined;
  const userMessage = request.kind === 'resume' ? request.run.user_message : request.args;
  const parseWarnings = request.kind === 'start' ? request.parseWarnings : undefined;
  const runCwd = conversation.cwd ?? codebase.default_cwd;
  // The codebase's stored default branch — the $BASE_BRANCH fallback for every
  // executeWorkflow dispatch below (repo config worktree.baseBranch still wins).
  const codebaseBaseBranch = codebase.default_branch?.trim() || undefined;
  const scope: DispatchScope = {
    owner,
    platform,
    conversationId,
    conversation,
    codebase,
    actor,
    userId,
    isolationHints,
    source,
    options,
    userMessage,
    parseWarnings,
    runCwd,
    codebaseBaseBranch,
    // Shared across every dispatch below.
    resolveChildIsolation: createCodebaseChildResolver(
      sqlIsolation.createIsolationStore(),
      codebase,
      {
        baseBranch: codebaseBaseBranch,
        createdByPlatform: platform.getPlatformType(),
        createdByUserId: userId,
      },
      createWorkflowDeps()
    ),
  };

  const requested = await resolveRequestedWorkflow(scope, request);
  if (requested === undefined) return;
  let workflow = requested;
  const adoption = await resolveDispatchAdoption(scope, workflow);
  const adoptionLane = adoption?.lane;
  const continuation = await detectContinuation(scope, request, workflow);
  if (continuation === undefined) return;
  const { resumableRun, explicitResumeRequested, willContinueExistingRun } = continuation;

  // ── Executable source ───────────────────────────────────────────────────────
  //
  // AFTER resume detection, on purpose. A continuation must execute the source its run
  // already froze; capturing here would freeze current bytes, re-resolve the graph from
  // them, and then hand the executor a run whose recorded capture supplies the commands
  // and scripts — a graph from one moment against resources from another. Capturing a
  // resume also leaves a staging directory nothing adopts.
  //
  // For a fresh run: freeze, then re-resolve the workflow FROM the frozen copy, so the
  // definition executed and the resources beside it are one consistent set of bytes.
  let freshCaptured: CapturedSource | undefined;

  if (request.kind === 'start' && willContinueExistingRun && resumableRun) {
    const resolved = await resolveRunWorkflow(createWorkflowDeps(), resumableRun, runCwd, platform);
    if (!resolved.ok) {
      await platform.sendMessage(
        conversationId,
        `Cannot continue run \`${resumableRun.id}\`: ${resolved.message}` +
          (resolved.resumeHint ? ` ${resolved.resumeHint}` : '')
      );
      return;
    }
    workflow = resolved.workflow;
  }

  // A reuse-worktree lane inherits the adopted run's worktree; its `.archon` belongs to
  // whatever branch that worktree carries, so the frozen source must come from THERE —
  // capturing from the parent checkout would mix vintages exactly as #2660 describes.
  // A checkout-branch lane captures a read-only snapshot before isolation exists.
  const adoptedEnvironment =
    adoptionLane?.kind === 'reuse-worktree'
      ? await resolveRegisteredWorktree(sqlIsolation, adoptionLane)
      : undefined;
  if (adoptedEnvironment) {
    if (platform.capabilities.defaultWorkflowDispatch === 'background') {
      await verifyWorktreeOwnership(
        toWorktreePath(adoptedEnvironment.working_path),
        toRepoPath(codebase.default_cwd)
      );
    } else {
      await recordWorktreeAdoption(sqlIsolation, adoptedEnvironment, codebase.default_cwd);
    }
  }
  const captureCwd = adoptedEnvironment?.working_path ?? runCwd;
  let branchPrepared: Awaited<ReturnType<typeof prepareRunAiConfiguration>> | undefined;
  if (!willContinueExistingRun && adoptionLane?.kind !== 'checkout-branch') {
    freshCaptured = await captureFreshSource(
      owner,
      captureCwd,
      workflow,
      conversationId,
      platform,
      adoptionLane?.kind === 'reuse-worktree' ? captureCwd : undefined
    );
    if (!freshCaptured) return; // capture failed, message already sent
    workflow = freshCaptured.workflow;
  }

  if (!willContinueExistingRun && adoptionLane?.kind === 'checkout-branch') {
    await withBranchLaunchSource(
      codebase.default_cwd,
      adoptionLane.taskBranch.branch,
      async snapshot => {
        freshCaptured = await captureFreshSource(
          owner,
          snapshot,
          workflow,
          conversationId,
          platform,
          snapshot
        );
        if (freshCaptured) {
          workflow = freshCaptured.workflow;
          branchPrepared = await prepareRunAiConfiguration(
            createWorkflowDeps(),
            workflow,
            snapshot,
            {
              codebaseId: codebase.id,
              userId,
              aiConfigurationRun: adoption?.adoptedRun,
              runConfig: options?.runConfig,
              ...(options?.modelOverrides
                ? { modelOverrideLayer: { kind: 'raw', overrides: options.modelOverrides } }
                : {}),
            }
          );
        }
      }
    );
    if (!freshCaptured) return;
  }

  const gates = await runSignatureGates(scope, workflow, willContinueExistingRun);
  if (!gates.ok) return;
  const { resolvedInputs, deferredInputError } = gates;

  await sendRunStartNotices(scope, workflow);

  if (resumableRun?.working_path && resumableRun.status !== 'paused' && !explicitResumeRequested) {
    getLog().info(
      {
        workflowName: workflow.name,
        resumableRunId: resumableRun.id,
        platformType: platform.getPlatformType(),
      },
      'orchestrator.failed_resume_user_prompted'
    );
    await platform.sendMessage(
      conversationId,
      buildFailedRunResumePrompt(platform, workflow.name, resumableRun, userMessage)
    );
    return;
  }
  // A fresh run reads repo config from the project's registered checkout, never from a
  // worktree an earlier run left on this conversation, so uncommitted and gitignored
  // config apply. An adopted worktree stays the estate. The run records the result, and
  // every continuation reuses that record.
  const launchConfigCwd =
    adoptionLane?.kind === 'reuse-worktree'
      ? adoptionLane.environment.working_path
      : codebase.default_cwd;
  const prepareLaunchAiConfiguration = (
    definition: ResolvedWorkflow
  ): ReturnType<typeof prepareRunAiConfiguration> =>
    prepareRunAiConfiguration(createWorkflowDeps(), definition, launchConfigCwd, {
      codebaseId: codebase.id,
      userId,
      aiConfigurationRun: adoption?.adoptedRun,
      runConfig: options?.runConfig,
      ...(options?.modelOverrides
        ? { modelOverrideLayer: { kind: 'raw', overrides: options.modelOverrides } }
        : {}),
    });
  const preparedAiConfiguration =
    branchPrepared ??
    (!willContinueExistingRun ? await prepareLaunchAiConfiguration(workflow) : undefined);
  if (preparedAiConfiguration)
    await assertRunCredentials(createWorkflowDeps(), preparedAiConfiguration);

  // Auto-attach project to conversation
  await db.updateConversation(conversation.id, {
    codebase_id: codebase.id,
  });

  if (!willContinueExistingRun && platform.capabilities.defaultWorkflowDispatch === 'background') {
    // Background dispatch: adapter-default workflows with no resumable run.
    // This is the console's default path, so it is exactly where a console-supplied
    // input map must not be dropped.
    await dispatchBackgroundWorkflow(
      {
        platform,
        conversationId,
        cwd: launchConfigCwd,
        originalMessage: userMessage,
        conversationDbId: conversation.id,
        codebaseId: codebase.id,
        availableWorkflows: [workflow],
        isolationHints,
        userId,
        source,
        parseWarnings,
        inputs: resolvedInputs,
        modelOverrides: options?.modelOverrides,
        runConfig: options?.runConfig,
        adoptRunId: options?.adoptRunId,
        supersedesRunId: options?.supersedesRunId,
        adoptionLane,
      },
      workflow
    );
    return;
  }

  const setupDeps = createWorkflowDeps();
  let setupRun: WorkflowRun | undefined;
  let setupOwner: Awaited<ReturnType<typeof startRunLiveOwner>> | undefined;
  let foregroundSubmitted = false;
  try {
    if (
      !willContinueExistingRun &&
      workflow.worktree?.enabled !== false &&
      freshCaptured &&
      preparedAiConfiguration
    ) {
      setupOwner = await startRunLiveOwner(freshCaptured.preparedSource.runId);
      setupRun = await setupDeps.store.createWorkflowRun({
        id: freshCaptured.preparedSource.runId,
        workflow_name: workflow.name,
        origin: { conversationId: conversation.id, parentConversationId: conversation.id, userId },
        codebase_id: codebase.id,
        user_message: userMessage,
        metadata: {
          [RUN_AI_CONFIGURATION_METADATA_KEY]: preparedAiConfiguration.aiConfigurationSnapshot,
          ...(preparedAiConfiguration.runConfigMetadata
            ? { [WORKFLOW_RUN_CONFIG_METADATA_KEY]: preparedAiConfiguration.runConfigMetadata }
            : {}),
          ...(resolvedInputs ? { [SUBRUN_METADATA_KEYS.inputs]: resolvedInputs } : {}),
          ...(options?.adoptRunId || options?.supersedesRunId
            ? { [CONTINUATION_METADATA_KEY]: { mode: options.adoptRunId ? 'adopt' : 'supersede' } }
            : {}),
        },
        ...(options?.adoptRunId || options?.supersedesRunId
          ? { adopted_from_run_id: options.adoptRunId ?? options.supersedesRunId }
          : {}),
      });
      freshCaptured = {
        ...freshCaptured,
        preparedSource: await retainSetupRunSource(
          setupDeps,
          setupRun,
          freshCaptured.preparedSource,
          owner,
          codebase.default_cwd,
          codebase.id
        ),
      };
    }
    const isolation = await resolveForegroundIsolation(scope, {
      workflow,
      willContinueExistingRun,
      resumableRun,
      adoptedEnvironment,
      adoptionLane,
      setupDeps,
      setupRun,
      preparedAiConfiguration,
    });
    if (isolation === undefined) return;
    const { cwd, cutFromCommit, ownedWorktree } = isolation;

    if (adoptionLane?.kind === 'checkout-branch' && freshCaptured) {
      freshCaptured = {
        ...freshCaptured,
        preparedSource: { ...freshCaptured.preparedSource, origin: cwd },
      };
      if (setupRun) await recordSetupRunSource(setupDeps, setupRun, freshCaptured.preparedSource);
    }

    // Dispatch workflow.
    // `resumableRun` was resolved above the signature gate (see the comment there):
    // resume detection runs for ALL platforms, so a prior run for this workflow in a
    // resumable state (paused — including approved-awaiting-resume, but excluding an
    // attention wait unless explicitly resumed — or failed) in this conversation+
    // codebase is continued rather than dispatched fresh. This ensures chat platforms
    // (slack, telegram, discord, github) resume after approval gates just like web does.
    if (resumableRun?.working_path) {
      await continueForegroundResume(scope, {
        workflow,
        resumableRun,
        resumableWorkingPath: resumableRun.working_path,
        resolvedInputs,
        deferredInputError,
        prepareLaunchAiConfiguration,
      });
    } else {
      await submitFreshForeground(scope, {
        workflow,
        freshCaptured,
        cwd,
        cutFromCommit,
        ownedWorktree,
        preparedAiConfiguration,
        setupRun,
        setupOwner,
        resolvedInputs,
        onSubmitted: () => {
          foregroundSubmitted = true;
        },
      });
    }
  } catch (error) {
    if (setupRun && !foregroundSubmitted && !(error instanceof TerminalStatusWriteError))
      await requireTerminalStatusWrite(
        setupDeps.store.failWorkflowRun(setupRun.id, toError(error).message, {
          exitReason: 'launch_failed',
        }),
        { workflowRunId: setupRun.id, site: 'foreground.preparation_failed' }
      );
    throw error;
  } finally {
    await setupOwner?.close();
  }
}

/** The workflow the request names; `undefined` after telling the user it cannot run. */
async function resolveRequestedWorkflow(
  scope: DispatchScope,
  request: WorkflowRequest
): Promise<ResolvedWorkflow | undefined> {
  const { platform, conversationId, runCwd } = scope;
  if (request.kind === 'resume') {
    if (!request.run.working_path) {
      getLog().warn({ runId: request.run.id }, 'orchestrator.resume_missing_working_path');
      await platform.sendMessage(
        conversationId,
        `Cannot resume ${request.run.id}: missing working path.`
      );
      return undefined;
    }
    const resolved = await resolveRunWorkflow(createWorkflowDeps(), request.run, runCwd, platform);
    if (!resolved.ok) {
      await platform.sendMessage(
        conversationId,
        `Cannot continue run \`${request.run.id}\`: ${resolved.message}` +
          (resolved.resumeHint ? ` ${resolved.resumeHint}` : '')
      );
      return undefined;
    }
    return resolved.workflow;
  }
  return request.definition;
}

async function resolveDispatchAdoption(
  scope: DispatchScope,
  workflow: ResolvedWorkflow
): Promise<DispatchAdoption | undefined> {
  const { codebase, options } = scope;
  // Between-run continuation (#2747): adoption is validated by the ONE resolver,
  // whatever surface declared it — CLI, API, or chat. A non-terminal target, a
  // cross-codebase id, or a missing estate refuses here, before any worktree is
  // cut; the resolved lane then drives where the run actually executes.
  const adoption = options?.adoptRunId
    ? await resolveWorkflowAdoption({
        deps: {
          getRun: sqlWorkflow.getWorkflowRun,
          getActiveRunByPath: sqlWorkflow.getActiveWorkflowRunByPath,
          findEnvironmentByPath: sqlIsolation.findLatestByCodebaseAndWorkingPath,
        },
        adoptedRunId: options.adoptRunId,
        codebaseId: codebase.id,
        codebasePath: codebase.default_cwd,
        codebaseKind: codebase.kind,
      })
    : undefined;
  const adoptionLane = adoption?.lane;

  // A lane other than in-place inherits a worktree or branch estate; a workflow
  // that opted out of worktrees runs in the parent checkout and has nothing to
  // inherit, so honoring the adoption would mean silently dropping the lane.
  if (
    options?.adoptRunId !== undefined &&
    adoptionLane !== undefined &&
    adoptionLane.kind !== 'in-place' &&
    workflow.worktree?.enabled === false
  ) {
    throw new WorkflowAdoptionError(
      `Cannot adopt run '${options.adoptRunId}': workflow '${workflow.name}' disables ` +
        'worktrees, so there is no worktree or branch estate to inherit. ' +
        'Drop the adoption or run a worktree-isolated workflow.'
    );
  }
  return adoption;
}

interface Continuation {
  resumableRun: WorkflowRun | null;
  explicitResumeRequested: boolean;
  willContinueExistingRun: boolean;
}

/** Which existing run this dispatch continues, if any; `undefined` after a refusal was sent. */
async function detectContinuation(
  scope: DispatchScope,
  request: WorkflowRequest,
  workflow: ResolvedWorkflow
): Promise<Continuation | undefined> {
  const { platform, conversationId, conversation, codebase, actor, options } = scope;
  // Resume detection, hoisted above the signature gate ON PURPOSE (#2554).
  //
  // This function continues an existing run in TWO ways: an explicit
  // `/workflow resume <id>` (which carries one run), and an
  // IMPLICIT auto-detection that fires for a plain `/workflow run <name>` on every
  // platform — the lookup that used to live further down, next to the dispatch. An
  // attention wait is excluded from that implicit path: only the explicit form
  // may consume it. The gate below still has to know about both continuation forms:
  // gating only against the explicit form wrongly refused a required-input workflow
  // that was merely being continued (the run row already holds its validated inputs,
  // and the caller supplies nothing when they just say "run it" again).
  //
  // It has to be hoisted rather than the gate pushed down: `validateAndResolveIsolation`
  // sits between here and the old lookup site and CREATES WORKTREES, so gating after it
  // would forfeit the pre-cost refusal. This lookup is a single indexed DB read — no
  // worktree, no clone, no AI — so it is safe to do before gating. Its inputs
  // (`conversation.id`, `codebase.id`) are parameters and nothing below mutates them.
  const resumeCandidate =
    request.kind === 'resume'
      ? request.run
      : request.force
        ? null
        : await workflowDb.findResumableRunByParentConversation(
            workflow.name,
            conversation.id,
            codebase.id
          );
  const explicitResumeRequested = request.kind === 'resume';
  const resumableRun =
    !explicitResumeRequested &&
    resumeCandidate !== null &&
    isWorkflowWaitContext(resumeCandidate.metadata.wait) &&
    resumeCandidate.metadata.wait.kind === 'attention'
      ? null
      : resumeCandidate;
  // Whether this dispatch will CONTINUE existing work rather than create a fresh run
  // row. Deliberately the exact negation of the resume/abandon/force menu's condition
  // below: a candidate that is neither paused nor the explicitly-targeted run does not
  // continue — it shows that menu and returns. Only a genuine continuation may defer the
  // signature gate, so an invocation that was never going to continue is still refused
  // immediately, with the specific input error rather than a generic menu, and before
  // isolation resolution can create a worktree.
  const willContinueExistingRun =
    Boolean(resumableRun?.working_path) &&
    (resumableRun?.status === 'paused' || explicitResumeRequested);

  if (willContinueExistingRun && resumableRun) {
    try {
      await createSqlWorkflowOperations().resumeWorkflow(resumableRun.id, actor);
    } catch (error) {
      if (!(error instanceof RunActionForbiddenError)) throw error;
      await platform.sendMessage(conversationId, error.message);
      return undefined;
    }
  }

  // Adoption and continuation are mutually exclusive: both decide where the run
  // executes and which estate it inherits, and every continuation path below forwards
  // only the resume context — an adopted id would be validated above and then silently
  // dropped. Refuse the combination up front, mirroring the CLI's adopt/resume guard.
  if (options?.adoptRunId !== undefined && willContinueExistingRun && resumableRun) {
    throw new WorkflowAdoptionError(
      `Cannot adopt run '${options.adoptRunId}': this conversation already continues ` +
        `run '${resumableRun.id}' (${resumableRun.status}). Resume or abandon that run ` +
        'first, or declare the adoption from a conversation with no open run.'
    );
  }
  return { resumableRun, explicitResumeRequested, willContinueExistingRun };
}

type SignatureGates =
  | { ok: false }
  | { ok: true; resolvedInputs?: Record<string, string>; deferredInputError?: Error };

/**
 * Input signature gate (#2470, #2554) plus capability gate, judged against ONE
 * workflow definition. A checkout-branch adoption swaps the definition for the
 * branch's vintage only after isolation resolves its worktree, so these gates must
 * run AFTER that swap there — otherwise required inputs or `requires:` declared on
 * the branch would bypass them entirely.
 */
async function runSignatureGates(
  scope: DispatchScope,
  definition: ResolvedWorkflow,
  willContinueExistingRun: boolean
): Promise<SignatureGates> {
  const { platform, conversationId, userId, options } = scope;
  let resolvedInputs: Record<string, string> | undefined;
  // A contract violation held back because a resume may make it moot. Only the one
  // branch in `continueForegroundResume` that falls through to a FRESH run row (hydration found nothing worth
  // resuming) still needs it; every other continuation path never reads inputs from
  // this invocation at all.
  let deferredInputError: Error | undefined;

  // Resolve this invocation's declared inputs from the values its channel supplied —
  // the run route's `inputs` map or the chat agent's `invoke_workflow` launch. A channel
  // that supplies nothing still refuses a required-input workflow here. The workflow still
  // lists/loads normally.
  try {
    resolvedInputs = resolveTopLevelInputs(definition, options?.inputs);
  } catch (err) {
    // Both are user-facing contract violations: a missing required input, and — now
    // that a caller can supply values — a key the workflow does not declare.
    if (err instanceof WorkflowMissingInputsError || err instanceof WorkflowInputContractError) {
      getLog().info(
        {
          workflowName: definition.name,
          // Names only, never values — a supplied value is user content (logging rules).
          missing: err instanceof WorkflowMissingInputsError ? err.missing : undefined,
          suppliedKeys: options?.inputs ? Object.keys(options.inputs) : [],
          deferred: willContinueExistingRun,
        },
        'workflow.required_inputs_unsatisfiable'
      );
      if (!willContinueExistingRun) {
        await platform.sendMessage(conversationId, err.message);
        return { ok: false };
      }
      deferredInputError = err;
    } else {
      throw err;
    }
  }

  // Capability gate: hard-fail before any worktree/clone/AI cost if the
  // workflow declares `requires: [github]` and the originating user hasn't
  // connected. No-op when per-user GitHub is disabled (solo PAT installs).
  if (isPerUserGitHubEnabled() && definition.requires?.length) {
    const githubConnected = userId ? Boolean(await getDecryptedAccessToken(userId)) : false;
    try {
      assertWorkflowRequirementsMet(definition, { githubConnected });
    } catch (err) {
      if (err instanceof WorkflowRequirementError) {
        getLog().info(
          { workflowName: definition.name, conversationId, userId, requirement: err.requirement },
          'workflow.requirement_unmet'
        );
        await platform.sendMessage(conversationId, err.message);
        return { ok: false };
      }
      throw err;
    }
  }
  return { ok: true, resolvedInputs, deferredInputError };
}

async function sendRunStartNotices(
  scope: DispatchScope,
  workflow: ResolvedWorkflow
): Promise<void> {
  const { platform, conversationId, parseWarnings } = scope;
  // Keys the engine dropped from this workflow's YAML (#2213). Every chat and
  // console run funnels through here, so this is the one place that covers all
  // of them. Sent before the run starts and independently of the run's own
  // output, so it lands even when the workflow immediately backgrounds itself.
  // Best-effort: a delivery failure must not stop the run the user asked for.
  if (parseWarnings && parseWarnings.length > 0) {
    const lines = parseWarnings.map(w => `- ${w}`).join('\n');
    try {
      await platform.sendMessage(
        conversationId,
        `⚠️ \`${workflow.name}\` declares keys the engine ignores:\n${lines}`
      );
    } catch (error) {
      getLog().warn(
        { err: toError(error), conversationId, workflowName: workflow.name },
        'workflow.parse_warning_delivery_failed'
      );
    }
  }

  // Deprecated bundled default (#2781). Same reach as the parse warnings above:
  // every chat and console run funnels through here, before any background split,
  // so the removal notice lands on each surface the run reports to. Derived from
  // the definition itself — a copied override in project/global `.archon`
  // (same filename) drops the marker and the notice with it. Best-effort.
  const deprecationNotice = formatDeprecationNotice(workflow);
  if (deprecationNotice) {
    try {
      await platform.sendMessage(conversationId, deprecationNotice);
    } catch (error) {
      getLog().warn(
        { err: toError(error), conversationId, workflowName: workflow.name },
        'workflow.deprecation_notice_delivery_failed'
      );
    }
  }
}

interface ForegroundIsolation {
  cwd: string;
  cutFromCommit: string | undefined;
  ownedWorktree: OwnedWorktree | undefined;
}

/**
 * Validate and resolve isolation; `undefined` when isolation is blocked.
 * A workflow with `worktree.enabled: false` short-circuits the resolver entirely
 * and runs in the live checkout — no worktree creation, no env row. This is the
 * declarative equivalent of CLI `--no-worktree` for workflows that should always
 * run live (e.g. read-only triage, docs generation on the main checkout).
 */
async function resolveForegroundIsolation(
  scope: DispatchScope,
  input: {
    workflow: ResolvedWorkflow;
    willContinueExistingRun: boolean;
    resumableRun: WorkflowRun | null;
    adoptedEnvironment: AdoptedEnvironment | undefined;
    adoptionLane: DispatchAdoption['lane'] | undefined;
    setupDeps: ReturnType<typeof createWorkflowDeps>;
    setupRun: WorkflowRun | undefined;
    preparedAiConfiguration: PreparedAiConfiguration | undefined;
  }
): Promise<ForegroundIsolation | undefined> {
  const { platform, conversationId, conversation, codebase, isolationHints, userId } = scope;
  const {
    workflow,
    willContinueExistingRun,
    resumableRun,
    adoptedEnvironment,
    adoptionLane,
    setupDeps,
    setupRun,
    preparedAiConfiguration,
  } = input;
  let cwd: string;
  let cutFromCommit: string | undefined;
  let ownedWorktree: OwnedWorktree | undefined;
  if (willContinueExistingRun && resumableRun?.working_path) {
    cwd = resumableRun.working_path;
    const env = await sqlIsolation.findLatestByCodebaseAndWorkingPath(codebase.id, cwd, new Date());
    if (env?.status === 'active')
      await recordWorktreeAdoption(sqlIsolation, env, codebase.default_cwd);
  } else if (adoptedEnvironment) {
    // Adoption lane: the adopted run's worktree survives — run in it dirty-as-is
    // instead of cutting a fresh one (same shape as the background dispatch in
    // orchestrator.ts). Linking the env keeps isolation hygiene pointed at this
    // checkout.
    cwd = adoptedEnvironment.working_path;
    await db
      .updateConversation(conversation.id, {
        cwd,
        isolation_env_id: adoptedEnvironment.id,
      })
      .catch((e: unknown) => {
        getLog().warn(
          { err: toError(e), conversationId },
          'orchestrator.worker_cwd_persist_failed'
        );
      });
  } else if (workflow.worktree?.enabled === false) {
    getLog().info(
      { workflowName: workflow.name, conversationId, codebaseId: codebase.id },
      'workflow.worktree_disabled_by_policy'
    );
    cwd = codebase.default_cwd;
  } else {
    try {
      const result = await validateAndResolveIsolation(
        // A checkout-branch adoption must not adopt the conversation's existing env:
        // the resolver short-circuits on `existingEnvId` before hints are read (R7), so a
        // stale worktree from an earlier run in this conversation would win over the
        // adopted branch. Null it out — same shape the `stale_cleaned` retry sees.
        {
          ...conversation,
          codebase_id: codebase.id,
          ...(adoptionLane?.kind === 'checkout-branch' ? { isolation_env_id: null } : {}),
        },
        codebase,
        platform,
        conversationId,
        adoptionLane?.kind === 'checkout-branch'
          ? {
              ...isolationHints,
              // Unique per dispatch: a shared id would key the reuse lookup to an
              // earlier adoption's worktree and drop the exact branch on later ones.
              workflowId: randomUUID(),
              workflowType: 'task',
              taskBranch: adoptionLane.taskBranch,
            }
          : isolationHints,
        false,
        userId,
        setupRun && preparedAiConfiguration
          ? createRunWorktreeSetupExecutor(setupDeps, setupRun, preparedAiConfiguration.config)
          : undefined
      );
      cwd = result.cwd;
      if (result.status === 'new') {
        cutFromCommit = result.cutFromCommit;
        ownedWorktree = result.ownedWorktree;
      }
    } catch (error) {
      if (error instanceof IsolationBlockedError) {
        if (setupRun)
          await requireTerminalStatusWrite(
            setupDeps.store.failWorkflowRun(setupRun.id, error.message, {
              exitReason: 'launch_failed',
            }),
            { workflowRunId: setupRun.id, site: 'foreground.worktree_setup_failed' }
          );
        getLog().warn(
          {
            reason: error.reason,
            conversationId,
            codebaseId: codebase.id,
            workflowName: workflow.name,
          },
          'isolation_blocked'
        );
        return undefined;
      }
      throw error;
    }
  }
  return { cwd, cutFromCommit, ownedWorktree };
}

/**
 * Continue the detected run in the foreground, or start fresh in its worktree when it has
 * nothing to resume.
 */
async function continueForegroundResume(
  scope: DispatchScope,
  input: {
    workflow: ResolvedWorkflow;
    resumableRun: WorkflowRun;
    resumableWorkingPath: string;
    resolvedInputs: Record<string, string> | undefined;
    deferredInputError: Error | undefined;
    prepareLaunchAiConfiguration: (
      definition: ResolvedWorkflow
    ) => ReturnType<typeof prepareRunAiConfiguration>;
  }
): Promise<void> {
  const {
    owner,
    platform,
    conversationId,
    conversation,
    codebase,
    userId,
    source,
    options,
    userMessage,
    parseWarnings,
    runCwd,
    codebaseBaseBranch,
    resolveChildIsolation,
  } = scope;
  const {
    resumableRun,
    resumableWorkingPath,
    resolvedInputs,
    deferredInputError,
    prepareLaunchAiConfiguration,
  } = input;
  let workflow = input.workflow;

  getLog().info(
    {
      workflowName: workflow.name,
      resumableRunId: resumableRun.id,
      workingPath: resumableRun.working_path,
      platformType: platform.getPlatformType(),
    },
    'orchestrator.foreground_resume_detected'
  );
  // An empty resume is the explicit restart path below; a lost claim never
  // falls through to a fresh run on another owner's worktree.
  const deps = createWorkflowDeps();
  const engine = new InProcessWorkflowEngine(deps);
  const resumeOwner = await startRunLiveOwner(resumableRun.id);
  let resumeOwnerClosed = false;
  try {
    let admission: WorkflowResumeAdmission;
    try {
      const needsResumeNotice =
        options?.runConfig !== undefined ||
        Object.keys(options?.inputs ?? {}).length > 0 ||
        Object.keys(options?.modelOverrides?.tiers ?? {}).length > 0 ||
        Object.keys(options?.modelOverrides?.aliases ?? {}).length > 0;
      const nothingToResume =
        needsResumeNotice && (await inspectResumableRun(deps, resumableRun)) === null;
      if (nothingToResume) {
        admission = { accepted: false, reason: 'nothing-to-resume' };
      } else {
        if (options?.runConfig) {
          await platform.sendMessage(
            conversationId,
            'This command would resume an existing run, so a new run config cannot be applied. ' +
              'Resume without config, or force a fresh run.'
          );
          return;
        }
        const resumeStateLabel = formatResumableRunState(resumableRun.status);
        const suppliedModelBindingNames = [
          ...Object.keys(options?.modelOverrides?.tiers ?? {}),
          ...Object.keys(options?.modelOverrides?.aliases ?? {}),
        ].sort();
        // A resume replays the inputs stamped on its own row; values supplied on THIS
        // call cannot reach it (the row already exists, so the executor's stamp never
        // fires). Say so rather than accepting them and quietly running something else.
        if (options?.inputs && Object.keys(options.inputs).length > 0) {
          const ignored = Object.keys(options.inputs).sort().join(', ');
          getLog().info(
            {
              workflowName: workflow.name,
              resumableRunId: resumableRun.id,
              ignoredKeys: ignored,
            },
            'orchestrator.resume_ignored_supplied_inputs'
          );
          await platform.sendMessage(
            conversationId,
            `▶️ Resuming the ${resumeStateLabel} run of **${workflow.name}** (\`${resumableRun.id}\`), which ` +
              `keeps the inputs it started with — the values you supplied now (${ignored}) were ` +
              'not applied. To run fresh with them instead, abandon that run first ' +
              `(\`${spellWorkflowCommand(platform, `abandon ${resumableRun.id}`)}\`) and re-invoke.`
          );
        }
        if (suppliedModelBindingNames.length > 0) {
          getLog().info(
            {
              workflowName: workflow.name,
              resumableRunId: resumableRun.id,
              ignoredBindings: suppliedModelBindingNames,
            },
            'orchestrator.resume_ignored_model_bindings'
          );
          await platform.sendMessage(
            conversationId,
            `▶️ Resuming the ${resumeStateLabel} run of **${workflow.name}** (\`${resumableRun.id}\`), which ` +
              'keeps the model bindings it started with — the bindings you supplied now ' +
              `(${suppliedModelBindingNames.join(', ')}) were not applied. To run fresh with them ` +
              `instead, abandon that run first (\`${spellWorkflowCommand(platform, `abandon ${resumableRun.id}`)}\`) and re-invoke.`
          );
        }
        admission = await engine.resume({
          platform,
          conversationId,
          cwd: resumableWorkingPath,
          legacyWorkflow: workflow,
          userMessage,
          origin: {
            conversationId: conversation.id,
            userId,
            parentConversationId: conversation.id,
          },
          run: resumableRun,
          options: {
            codebaseId: codebase.id,
            source,
            parseWarnings,
            baseBranch: codebaseBaseBranch,
            resolveChildIsolation,
          },
        });
      }
    } catch (err) {
      // The gate deferred a contract violation because this looked like a
      // continuation; when the run does not continue here it is never surfaced
      // anywhere else. Say it rather than let an already-computed, actionable error die.
      const deferredNote =
        deferredInputError && options?.inputs && Object.keys(options.inputs).length > 0
          ? `\n\nAlso note: ${deferredInputError.message}`
          : '';
      // resumeWorkflowRun is a compare-and-swap: if another surface (web Resume,
      // a concurrent re-dispatch, the CLI) already claimed this run, it throws
      // WorkflowNotResumableError. Surface a friendly note instead of leaking the
      // raw internal string to the generic failure catch, and do NOT fall through
      // to a fresh run — the other resumer owns the worktree (#1830 I2).
      if (err instanceof workflowDb.WorkflowNotResumableError) {
        getLog().info(
          { workflowName: workflow.name, runId: resumableRun.id, status: err.currentStatus },
          'orchestrator.resume_lost_race'
        );
        await platform.sendMessage(
          conversationId,
          `⚠️ **${workflow.name}** is already being resumed (status: ${err.currentStatus}). ` +
            'No action taken — follow the existing run for progress.' +
            deferredNote
        );
        return;
      }
      // The run keeps its state; only its resource is busy. Never fall through to a fresh run.
      if (err instanceof workflowDb.WorkflowResourceBusyError) {
        getLog().info(
          {
            workflowName: workflow.name,
            runId: resumableRun.id,
            blocker: err.blocker,
            refusal: err.refusal,
          },
          'orchestrator.resume_resource_busy'
        );
        await platform.sendMessage(
          conversationId,
          `⏳ **${workflow.name}** cannot resume yet. ${err.message}` + deferredNote
        );
        return;
      }
      throw err;
    }
    if (admission.accepted) {
      await admission.settled;
    } else {
      await resumeOwner.close();
      resumeOwnerClosed = true;
      // Hydration found nothing worth resuming, so this is the ONE continuation path
      // that creates a fresh run row — which means a contract violation deferred at the
      // gate is live again and must be surfaced before any AI cost.
      if (deferredInputError) {
        await platform.sendMessage(conversationId, deferredInputError.message);
        return;
      }
      // This branch IS a fresh run, even though the outer block entered via the resume
      // menu (#2686). Capture the source here so the run freezes the bytes it actually
      // executes against; without this it would inherit the prior run's frozen graph
      // and let the executor fall back to live command/script lookup, which is exactly
      // the mixed-vintage shape #2660 exists to remove.
      const captured = await captureFreshSource(owner, runCwd, workflow, conversationId, platform);
      if (!captured) return; // capture failed, message already sent
      workflow = captured.workflow;
      const freshAiConfiguration = await prepareLaunchAiConfiguration(workflow);
      await assertRunCredentials(createWorkflowDeps(), freshAiConfiguration);
      await platform.sendMessage(
        conversationId,
        `⚠️ Prior run for **${workflow.name}** had no completed nodes; starting fresh in the same worktree.`
      );
      // The wrap owns the capture until `executeWorkflow`'s rename succeeds; the
      // executor adopts for us there (see #2690). `captured.preparedSource` proves
      // the helper has already run `owner.hold`, which is the only thing the wrap
      // needs to know to reclaim if the rename fails.
      await withRunLiveOwner(captured.preparedSource.runId, {}, async () => {
        await engine.submit({
          platform,
          conversationId,
          cwd: resumableWorkingPath,
          workflow,
          userMessage,
          origin: {
            conversationId: conversation.id,
            userId,
            parentConversationId: conversation.id,
          },
          options: {
            codebaseId: codebase.id,
            source,
            preparedSource: captured.preparedSource,
            preparedAiConfiguration: freshAiConfiguration,
            parseWarnings,
            baseBranch: codebaseBaseBranch,
            resolveChildIsolation,
            capturedSourceOwner: owner,
            // This branch creates a FRESH run row (the prior run had nothing to resume),
            // so the supplied inputs still need stamping.
            inputs: resolvedInputs,
            ...(options?.modelOverrides
              ? {
                  modelOverrideLayer: {
                    kind: 'raw' as const,
                    overrides: options.modelOverrides,
                  },
                }
              : {}),
            ...(options?.runConfig ? { runConfig: options.runConfig } : {}),
          },
        });
      });
    }
  } finally {
    if (!resumeOwnerClosed) await resumeOwner.close();
  }
}

async function submitFreshForeground(
  scope: DispatchScope,
  input: {
    workflow: ResolvedWorkflow;
    freshCaptured: CapturedSource | undefined;
    cwd: string;
    cutFromCommit: string | undefined;
    ownedWorktree: OwnedWorktree | undefined;
    preparedAiConfiguration: PreparedAiConfiguration | undefined;
    setupRun: WorkflowRun | undefined;
    setupOwner: Awaited<ReturnType<typeof startRunLiveOwner>> | undefined;
    resolvedInputs: Record<string, string> | undefined;
    /** Called as the submit starts: from then on the engine owns the run's failure. */
    onSubmitted: () => void;
  }
): Promise<void> {
  const {
    owner,
    platform,
    conversationId,
    conversation,
    codebase,
    userId,
    source,
    options,
    userMessage,
    parseWarnings,
    codebaseBaseBranch,
    resolveChildIsolation,
  } = scope;
  const {
    workflow,
    freshCaptured,
    cwd,
    cutFromCommit,
    ownedWorktree,
    preparedAiConfiguration,
    setupRun,
    setupOwner,
    resolvedInputs,
    onSubmitted,
  } = input;
  // Fresh foreground execution for foreground-default adapters.
  // Reaching this means `resumableRun?.working_path` is falsy, which implies
  // `willContinueExistingRun` was false and the source capture ran. `freshCaptured` is
  // invariantly defined here — the capture-flow helper ran before this.
  if (!freshCaptured) {
    // Should never trigger; the reasoning above is the invariant. If it does, the
    // dispatch would hand a `preparedSource: undefined` to the executor and we are
    // about to fall into the executor's `source_unprepared_live` branch — the
    // mixed-vintage shape #2660 exists to remove — so refuse loudly rather than
    // ship that regression silently.
    throw new Error(
      'orchestrator invariant violated: fresh-foreground dispatch reached without a captured source'
    );
  }
  const freshDeps = createWorkflowDeps();
  const freshEngine = new InProcessWorkflowEngine(freshDeps);
  const captured = freshCaptured;
  const submitFresh = async (): Promise<void> => {
    onSubmitted();
    await freshEngine.submit({
      platform,
      conversationId,
      cwd,
      workflow,
      userMessage,
      origin: {
        conversationId: conversation.id,
        parentConversationId: conversation.id,
        userId,
      },
      options: {
        codebaseId: codebase.id,
        source,
        preparedSource: captured.preparedSource,
        preparedAiConfiguration,
        preCreatedRun: setupRun,
        parseWarnings,
        baseBranch: codebaseBaseBranch,
        resolveChildIsolation,
        capturedSourceOwner: owner,
        inputs: resolvedInputs,
        ...(cutFromCommit !== undefined ? { cutFromCommit } : {}),
        ownedWorktree,
        ...(options?.adoptRunId
          ? { adoptedFromRunId: options.adoptRunId, continuationMode: 'adopt' as const }
          : options?.supersedesRunId
            ? {
                adoptedFromRunId: options.supersedesRunId,
                continuationMode: 'supersede' as const,
              }
            : {}),
        ...(options?.modelOverrides
          ? {
              modelOverrideLayer: { kind: 'raw' as const, overrides: options.modelOverrides },
            }
          : {}),
        ...(options?.runConfig ? { runConfig: options.runConfig } : {}),
      },
    });
  };
  if (setupOwner) await submitFresh();
  else await withRunLiveOwner(captured.preparedSource.runId, {}, submitFresh);
}

/**
 * Freeze the workflow source and re-resolve the workflow FROM the freeze.
 *
 * A fresh run row is created from the captured bytes — commands and scripts beside
 * the DAG come from the same moment as the DAG itself. Without this, an edited
 * workflow would silently run its new graph against pre-edit command bytes; this is
 * the exact shape #2660 exists to remove, and the exact shape that must be avoided in
 * the fresh-run-in-same-worktree fallback (#2686).
 *
 * On success: hands the staged capture to the owner (`hold`), records the selected
 * workflow name, and returns both the prepared source and the freshly resolved graph.
 * The caller adopts when a run takes over.
 *
 * On failure: sends the user-facing message and returns `undefined`. The caller MUST
 * `return` immediately — the owner reclaims any unadopted capture on the way out, so
 * no manual cleanup is needed.
 */
async function captureFreshSource(
  owner: CapturedSourceOwner,
  runCwd: string,
  workflow: ResolvedWorkflow,
  conversationId: string,
  platform: IPlatformAdapter,
  explicitSourceRoot?: string
): Promise<CapturedSource | undefined> {
  try {
    const workflowSourceRoot = explicitSourceRoot ?? (await resolveWorkflowSourceRoot(runCwd));
    const preparedSource = await prepareWorkflowSource(createWorkflowDeps(), {
      sourceRoot: workflowSourceRoot ?? runCwd,
    });
    // From here the owner reclaims it unless a run adopts it, whichever way we leave.
    owner.hold(preparedSource);
    // Re-resolve only when files were actually frozen. An empty capture means the
    // definition came from the bundled set a binary embeds as constants — immutable for
    // that binary, with nothing on disk to re-read.
    let resolvedWorkflow = workflow;
    if (preparedSource.manifest.scopes.length > 0) {
      const { workflows: capturedWorkflows } = await discoverWorkflowsWithConfig(
        runCwd,
        loadConfig,
        providerRegistry,
        preparedSource.roots
      );
      const reResolved = resolveWorkflowName(
        workflow.name,
        capturedWorkflows.map(w => w.workflow)
      );
      if (!reResolved) {
        // No manual cleanup: the owner reclaims anything unadopted on the way out.
        await platform.sendMessage(
          conversationId,
          `Could not read workflow **${workflow.name}** from this run's captured source. ` +
            'Nothing has been started.'
        );
        return undefined;
      }
      resolvedWorkflow = reResolved;
    }
    await recordSelectedWorkflow(preparedSource.anchor.root, resolvedWorkflow.name);
    return { preparedSource, workflow: resolvedWorkflow };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowName: workflow.name }, 'workflow.source_capture_failed');
    await platform.sendMessage(
      conversationId,
      `Could not capture the workflow source for **${workflow.name}**: ${err.message}. ` +
        'Nothing has been started.'
    );
    return undefined;
  }
}

/**
 * Dispatch a workflow, owning any capture it takes.
 *
 * A thin owner around the implementation, matching the CLI's shape. The implementation has
 * five ordinary early returns after a capture is allocated — the inputs gate, the GitHub
 * requirement gate, an isolation error, a resume with no working path, and the routine
 * "resume or force?" menu — and every one of them used to abandon a complete frozen tree.
 */
export async function dispatchOrchestratorWorkflow(
  platform: IPlatformAdapter,
  conversationId: string,
  conversation: Conversation,
  codebase: Codebase,
  request: WorkflowRequest,
  actor: RunActor,
  isolationHints?: HandleMessageContext['isolationHints'],
  source?: WorkflowSource,
  options?: WorkflowDispatchOptions
): Promise<void> {
  await withCapturedSource(owner =>
    dispatchOrchestratorWorkflowOwned(
      owner,
      platform,
      conversationId,
      conversation,
      codebase,
      request,
      actor,
      isolationHints,
      source,
      options
    )
  );
}

/** A human gate the chat agent resolved during a turn, awaiting continuation. */
export interface ResolvedGate {
  run: WorkflowRun;
  action: 'approve' | 'reject' | 'respond';
}

/**
 * Continue a run whose human gate the chat agent just resolved (#2565).
 *
 * A resolution leaves the run `paused` on purpose — `approveWorkflow` and
 * `rejectWorkflow` record the decision and let the caller decide when to move
 * (`workflow-operations.ts`). This is chat's "when": the same resume dispatch the
 * removed natural-language branch performed, now triggered by the agent's
 * explicit approve/reject verb instead of by "the message did not start with /".
 * Resolution without continuation would strand the run on every chat surface.
 *
 * Never throws — the gate decision is already committed, so a failure here costs
 * the user a manual `/workflow resume`, not the decision. The whole body is
 * guarded so that guarantee holds for the `finally` this runs from, where a
 * throw would replace the error the user actually needs to see.
 *
 * Exported so its continuation behavior can be tested without staging a whole agent turn
 * with a gate-resolving tool call.
 */
export async function continueResolvedGateRun(
  platform: IPlatformAdapter,
  conversationId: string,
  conversation: Conversation,
  codebase: Codebase | null,
  run: WorkflowRun,
  action: 'approve' | 'reject' | 'respond',
  actor: RunActor,
  isolationHints?: HandleMessageContext['isolationHints']
): Promise<void> {
  const decision =
    action === 'approve' ? 'Approved' : action === 'reject' ? 'Rejected' : 'Responded';
  const notify = async (text: string): Promise<void> => {
    await platform.sendMessage(conversationId, text).catch((sendErr: unknown) => {
      getLog().warn(
        { err: toError(sendErr), conversationId, workflowRunId: run.id },
        'orchestrator.gate_continuation_notice_failed'
      );
    });
  };

  try {
    if (!codebase) {
      getLog().warn(
        { conversationId, workflowRunId: run.id },
        'orchestrator.gate_continuation_no_codebase'
      );
      await notify(
        `${decision}, but no project is attached to this conversation, so the run could not ` +
          `continue. The decision is recorded — use \`${spellWorkflowCommand(platform, `resume ${run.id}`)}\` from the project.`
      );
      return;
    }

    getLog().info(
      { conversationId, workflowRunId: run.id, workflowName: run.workflow_name, action },
      'orchestrator.gate_continuation_requested'
    );
    try {
      await notify(`${decision}. Continuation requested for **${run.workflow_name}**.`);
      await dispatchOrchestratorWorkflow(
        platform,
        conversationId,
        conversation,
        codebase,
        { kind: 'resume', run },
        actor,
        isolationHints
      );
      getLog().info(
        { conversationId, workflowRunId: run.id, workflowName: run.workflow_name, action },
        'orchestrator.gate_continuation_request_handled'
      );
    } catch (error) {
      const err = toError(error);
      // The run's terminal status could not be written, so its row still says `running`
      // and its true outcome is unknown. `/workflow resume` is the wrong advice — it
      // refuses a non-terminal row, and the run may well have finished its work.
      if (error instanceof TerminalStatusWriteError) {
        getLog().error(
          { err, conversationId, workflowRunId: run.id, action },
          'orchestrator.gate_continuation_terminal_write_failed'
        );
        await notify(
          `${decision}, and **${run.workflow_name}** ran, but its final status could not be saved ` +
            `(${err.message}). The decision is recorded — check \`${spellWorkflowCommand(platform, `get ${run.id}`)}\` ` +
            'before starting another run on this project.'
        );
        return;
      }
      getLog().error(
        { err, errorType: err.constructor.name, conversationId, workflowRunId: run.id, action },
        'orchestrator.gate_continuation_failed'
      );
      await notify(
        `${decision}, but resuming **${run.workflow_name}** failed: ${err.message}. ` +
          `The decision is recorded — retry with \`${spellWorkflowCommand(platform, `resume ${run.id}`)}\`.`
      );
    }
  } catch (error) {
    // Belt and braces for the "never throws" contract the finally relies on.
    getLog().error(
      { err: toError(error), conversationId, workflowRunId: run.id, action },
      'orchestrator.gate_continuation_failed'
    );
  }
}

/**
 * Handle /workflow run command when project context may be missing.
 * Implements Edge Case E2 from the plan.
 */
export async function handleWorkflowRunCommand(
  platform: IPlatformAdapter,
  conversationId: string,
  conversation: Conversation,
  request: WorkflowRequest,
  actor: RunActor,
  isolationHints?: HandleMessageContext['isolationHints'],
  options?: WorkflowDispatchOptions
): Promise<void> {
  // Check if conversation has a project
  if (conversation.codebase_id) {
    const codebase = await codebaseDb.getCodebase(conversation.codebase_id);
    if (!codebase) {
      await platform.sendMessage(conversationId, 'Codebase not found.');
      return;
    }

    // Route through dispatchOrchestratorWorkflow so validateAndResolveIsolation
    // always runs — ensures a worktree is created regardless of how the codebase
    // was registered (local path or GitHub URL clone).
    await dispatchOrchestratorWorkflow(
      platform,
      conversationId,
      conversation,
      codebase,
      request,
      actor,
      isolationHints,
      undefined,
      options
    );
    return;
  }

  const codebases = await codebaseDb.listCodebases();

  if (codebases.length === 0) {
    await platform.sendMessage(
      conversationId,
      'No projects registered. Ask me to set up a project first.'
    );
    return;
  }

  // Never pick a project for the user, even when only one is registered.
  const projectList = codebases.map(c => `- ${c.name}`).join('\n');
  await platform.sendMessage(
    conversationId,
    request.kind === 'resume'
      ? `Choose a project for this conversation with \`/setproject <name>\`, then retry \`${spellWorkflowCommand(platform, `resume ${request.run.id}`)}\`.\n\n${projectList}`
      : `Which project should this workflow run on?\n\n${projectList}\n\nReply with the project name, or choose one with \`/setproject <name>\` and then use: ${spellWorkflowCommand(platform, `run ${request.definition.name} "${request.args}"`)}`
  );
}
