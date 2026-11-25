import type {
  HeldPreparation,
  RefusedPreparation,
  PendingStartBindingInspection,
  QueuedResourceStartInspection,
  StartBindingInspection,
} from '@archon/workflows/resource-start-store';
import { createRunWorktreeSetupExecutor } from './worktree-setup';
import { RUN_AI_CONFIGURATION_METADATA_KEY } from '@archon/workflows/run-ai-configuration';
import {
  prepareRunAiConfiguration,
  assertRunCredentials,
  type PreparedRunAiConfiguration,
  WorkflowCredentialPreflightError,
} from '@archon/workflows/run-preflight';
import { assertRunForgeAccess, ForgeRequirementError } from '@archon/workflows/run-forge-access';
import { assertReadFileSettings, FileSettingError } from '@archon/workflows/pack-settings';
import {
  requireTerminalStatusWrite,
  TerminalStatusWriteError,
} from '@archon/workflows/terminal-status-write';
/**
 * The host side of resource starts: prepare accepted receipt bindings, drain queued
 * requests, and start admitted runs through the engine port.
 *
 * It lives in core, not in a CLI or server, because every host drives the same steps
 * and only differs in how it starts an admitted run: the CLI hands each one to a
 * detached process, the server runs it in-process. Admission, the execution claim
 * fence, and recovery stay behind the supplied store; nothing here declares an owner dead.
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createLogger, canonicalizeProjectPath } from '@archon/paths';
import { NoDefaultProviderError } from '@archon/provider-contract';
import type { WorkflowEngineSubmitInput } from '@archon/workflows/engine-port';
import type { IWorkflowPlatform } from '@archon/workflows/deps';
import {
  finalizeWorkflowSource,
  preparedWorkflowSourceRecord,
  recordSelectedWorkflow,
  resolveContinuationWorkflow,
  withCapturedSource,
} from '@archon/workflows/run-source';
import { preparedSourceConfigRoot, runProjectConfigRoot } from '@archon/workflows/workflow-source';
import { canonicalValueText, type JsonValue } from '@archon/workflows/output-ref';
import {
  readWorkflowRunConfigMetadata,
  WORKFLOW_RUN_CONFIG_METADATA_KEY,
} from '@archon/workflows/run-config';
import {
  RESOURCE_START_METADATA_KEY,
  readResourceStartOrigin,
  readResourceStartReceiptId,
  ADMISSION_CHECKOUT_GUARD_METADATA_KEY,
  CHECKOUT_HANDOFF_METADATA_KEY,
  type CheckoutHandoffRunMetadata,
  type PreparedWorkflowLaunch,
  type ResourceStartBindingIntent,
  type ResourceStartDisposition,
  type ResourceStartRunMetadata,
} from '@archon/workflows/schemas/resource-start';
import type { ResolvedWorkflow, WorkflowExecutionResult } from '@archon/workflows/schemas/workflow';
import type { WorkflowItem } from '@archon/workflows/schemas/workflow-run';
import {
  SUBRUN_METADATA_KEYS,
  WORKFLOW_SOURCE_METADATA_KEY,
} from '@archon/workflows/schemas/workflow-run';
import { assertWorkflowRequirementsMet } from '@archon/workflows/utils/workflow-requirements';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import type { WorkflowRunConfigInput } from '@archon/workflows/schemas/run-config';
import {
  itemRunConfig,
  loadWorkflowRunConfigFile,
  unsealWorkflowRunConfig,
} from '../config/run-config';
import type { Codebase } from '../schemas/codebase';
import type { WorkflowHost } from './host-store';
import { registerRepository } from '../handlers/clone';
import {
  registeredProjectKeyForPath,
  resolveCodebaseForPath,
} from '../services/codebase-checkout-resolver';
import { startRunLiveOwner, type RunLiveOwner } from '../services/run-live-owner';
import { handOffAdmitted, type StartedExecutor } from './start-executor';
import { leaveForInstalledEngine } from './installed-engine-preparation';
import { releaseQueuedLaunchSource } from './queued-launch-source';
import {
  getTriggersPath,
  launchProjectKey,
  readStartFiles,
  type RebuildReads,
  type StartFiles,
} from './run-ended';
import { waitingStart, type WaitingStartFate } from './waiting-start';
import { createCodebaseChildResolver } from './child-isolation-resolver';
import { assertLaneStartable, executionLane, handoffIsolation } from './resource-start-lanes';
import { resolveBindingInputs, selectStartedWorkflow } from './binding-workflow';
import { refuseInPlaceLanding, resolveRunLanding } from './item-landing';
import {
  bindingItem,
  captureBindingDefinitions,
  definitionsStartCommit,
  recaptureInPlace,
  refuseWorktreeAfterInPlace,
} from './binding-definitions';

const log = createLogger('resource-start-host');

const PREPARATION_STAGES = ['run_as_user', 'run_configuration', 'launch_preparation'] as const;
type PreparationStage = (typeof PREPARATION_STAGES)[number];

/** The error a binding stores when its preparation fails at `stage`. */
function preparationStageFailure(stage: PreparationStage): `${PreparationStage}_failed` {
  return `${stage}_failed`;
}

/**
 * Whether a binding's stored error is the stage its preparation failed at. `trigger fire`
 * reads it so a binding another process failed to prepare fails the fire as its own would.
 */
export function isPreparationStageFailure(error: string | null): boolean {
  return PREPARATION_STAGES.some(stage => error === preparationStageFailure(stage));
}

interface BindingIdentity {
  receiptId: string;
  bindingId: string;
  ownerId: string;
}

async function findOrRegisterCodebase(host: WorkflowHost, cwd: string): Promise<Codebase> {
  const { codebase: found, repoRoot } = await resolveCodebaseForPath(cwd, host.records.codebases);
  if (found) return found;
  const registered = repoRoot
    ? await host.records.codebases.getCodebase(
        (await registerRepository(host.records.codebases, repoRoot)).codebaseId
      )
    : null;
  if (!registered) {
    throw new Error(`Cannot prepare a resource start from '${cwd}': register the project first.`);
  }
  return registered;
}

async function selectBindingWorkflow(
  host: WorkflowHost,
  launch: ResourceStartBindingIntent['launch'],
  cwd: string,
  roots: Parameters<typeof discoverWorkflowsWithConfig>[3]
): Promise<ResolvedWorkflow> {
  const discovered = await discoverWorkflowsWithConfig(
    cwd,
    host.deps.loadConfig,
    host.deps.providers,
    roots
  );
  const started = selectStartedWorkflow(launch, discovered);
  if ('workflow' in started) return started.workflow;
  throw new Error(`The binding starts nothing: ${started.refused}.`);
}

async function assertBindingRequirements(
  host: WorkflowHost,
  intent: ResourceStartBindingIntent,
  workflow: ResolvedWorkflow
): Promise<void> {
  if (!host.deps.isPerUserGitHubEnabled?.() || !workflow.requires?.length) return;
  assertWorkflowRequirementsMet(workflow, {
    githubConnected: Boolean(await host.deps.getUserGithubToken?.(intent.runAsUserId)),
  });
}

/** Reconcile the requested isolation with the workflow's pin and the project kind. */
function resolveBindingIsolation(
  requested: ResourceStartBindingIntent['launch']['isolation'],
  workflow: ResolvedWorkflow,
  codebase: Codebase
): PreparedWorkflowLaunch['execution']['isolation'] {
  const pinned = workflow.worktree?.enabled;
  if (requested.kind === 'in-place' && pinned === true) {
    throw new Error(`Workflow '${workflow.name}' requires worktree isolation.`);
  }
  if (requested.kind === 'worktree' && pinned === false) {
    throw new Error(`Workflow '${workflow.name}' requires in-place execution.`);
  }
  const wantsWorktree =
    requested.kind === 'worktree' ||
    (requested.kind === 'default' && codebase.kind !== 'folder' && pinned !== false);
  if (codebase.kind === 'folder' && (wantsWorktree || pinned === true)) {
    throw new Error(`Folder project '${codebase.name}' does not support worktree isolation.`);
  }
  return wantsWorktree
    ? { ...(requested.kind === 'worktree' ? requested : {}), kind: 'worktree' }
    : { kind: 'in-place' };
}

// The row holds the authored inputs and those naming the judged repository. The run fixes
// its settings and defaults on the row at start (resolveRunDispatch); a resume reads that.
function authoredInputsMetadata(inputs: Record<string, JsonValue>): Record<string, JsonValue> {
  if (Object.keys(inputs).length === 0) return {};
  return {
    [SUBRUN_METADATA_KEYS.inputs]: Object.fromEntries(
      Object.entries(inputs).map(([name, value]) => [name, canonicalValueText(value)])
    ),
    ...(Object.values(inputs).some(value => typeof value !== 'string')
      ? { [SUBRUN_METADATA_KEYS.inputsValues]: inputs }
      : {}),
  };
}

function bindingRunMetadata(
  workflow: ResolvedWorkflow,
  sourceRecord: JsonValue,
  origin: ResourceStartRunMetadata,
  inputs: Record<string, JsonValue>,
  preparedAi: PreparedRunAiConfiguration,
  handoff: CheckoutHandoffRunMetadata | undefined
): Record<string, JsonValue> {
  return {
    [RUN_AI_CONFIGURATION_METADATA_KEY]: preparedAi.aiConfigurationSnapshot,
    [WORKFLOW_SOURCE_METADATA_KEY]: sourceRecord,
    [RESOURCE_START_METADATA_KEY]: { ...origin },
    [ADMISSION_CHECKOUT_GUARD_METADATA_KEY]: workflow.mutates_checkout !== false,
    ...(handoff ? { [CHECKOUT_HANDOFF_METADATA_KEY]: { ...handoff } } : {}),
    ...authoredInputsMetadata(inputs),
    ...(preparedAi.runConfigMetadata
      ? { [WORKFLOW_RUN_CONFIG_METADATA_KEY]: preparedAi.runConfigMetadata }
      : {}),
  };
}

type PreparationResult = ResourceStartDisposition | HeldPreparation | RefusedPreparation;

/**
 * Freeze one binding's workflow source, inputs and run configuration, then commit it to
 * admission. The capture is kept only when admission keeps a promise to run it: a start
 * the install hold turned back is prepared again, from a fresh capture, after the lift.
 */
async function prepareBinding(
  host: WorkflowHost,
  intent: ResourceStartBindingIntent,
  identity: BindingIdentity,
  item: WorkflowItem | null,
  runConfig: WorkflowRunConfigInput | undefined
): Promise<PreparationResult> {
  const cwd = await canonicalizeProjectPath(intent.launch.cwd);

  return await withCapturedSource(async owner => {
    const codebase = await findOrRegisterCodebase(host, cwd);
    let source = await captureBindingDefinitions(host, intent, cwd, codebase, item);
    owner.hold(source);
    let workflow = await selectBindingWorkflow(host, intent.launch, cwd, source.roots);
    if (source.definitions?.from === 'base' && workflow.worktree?.enabled === false) {
      source = await recaptureInPlace(host, source, cwd);
      owner.hold(source);
      workflow = refuseWorktreeAfterInPlace(
        await selectBindingWorkflow(host, intent.launch, cwd, source.roots)
      );
    }
    await recordSelectedWorkflow(source.anchor.root, workflow.name);
    await assertBindingRequirements(host, intent, workflow);
    const bindingInputs = resolveBindingInputs(intent, workflow);
    // Before it takes a slot, so the refusal lands on the item's stop. A start on another
    // run's checkout opens its files there, not here, so its run's own start checks them.
    if (!intent.checkoutFrom) await assertReadFileSettings(cwd, workflow, bindingInputs);

    let isolation: PreparedWorkflowLaunch['execution']['isolation'];
    let handoff: CheckoutHandoffRunMetadata | undefined;
    if (intent.checkoutFrom) {
      const chosen = handoffIsolation(intent.checkoutFrom, workflow, codebase);
      isolation = chosen.isolation;
      handoff = { ...intent.checkoutFrom, lane: chosen.lane };
    } else {
      isolation = resolveBindingIsolation(intent.launch.isolation, workflow, codebase);
      await assertLaneStartable(isolation, codebase);
    }

    source = await finalizeWorkflowSource(host.deps, source, { cwd, codebaseId: codebase.id });
    owner.hold(source);
    const origin: ResourceStartRunMetadata = {
      receiptId: identity.receiptId,
      bindingId: identity.bindingId,
    };
    const preparedAi = await prepareRunAiConfiguration(host.deps, workflow, cwd, {
      configRoot: preparedSourceConfigRoot(source, cwd),
      codebaseId: codebase.id,
      userId: intent.runAsUserId,
      runConfig,
    });
    // Before admission, so a binding its forge cannot serve never takes a slot.
    const site = { cwd, settingsCwd: cwd, codebaseId: codebase.id, supplied: bindingInputs };
    const inputs = await assertRunForgeAccess(host.deps, workflow, preparedAi, site);
    const launch: PreparedWorkflowLaunch = {
      version: 2,
      run: {
        id: source.runId,
        workflow_name: workflow.name,
        origin: { userId: intent.runAsUserId },
        codebase_id: codebase.id,
        // Provenance is `metadata.resource_start`; a trigger supplies no user message.
        user_message: '',
        metadata: bindingRunMetadata(
          workflow,
          preparedWorkflowSourceRecord(source),
          origin,
          inputs,
          preparedAi,
          handoff
        ),
        ...(isolation.kind === 'in-place' ? { working_path: cwd } : {}),
      },
      execution: { cwd, conversationId: `trigger-${source.runId}`, isolation },
    };

    const disposition = await host.deps.store.completeStartBindingPreparation({
      ...identity,
      launch,
      ...(workflow.resource === undefined ? {} : { resource: workflow.resource }),
    });
    if (!disposition) throw new Error('Preparation ownership changed before durable acceptance.');
    if (disposition.status === 'admitted' || disposition.status === 'queued') owner.adopt();
    // The reason is on the rejected binding, which `trigger inspect` shows; it names no secret.
    if (disposition.status === 'refused')
      log.info({ ...identity, reason: disposition.reason }, 'resource_start.limit_reached');
    return disposition;
  });
}

async function prepareClaimedBinding(
  host: ResourceStartHost,
  intent: ResourceStartBindingIntent,
  identity: BindingIdentity
): Promise<PreparationResult> {
  let stage: PreparationStage = 'run_as_user';
  try {
    if (!(await host.records.users.getUserById(intent.runAsUserId))) {
      throw new Error('The configured run-as user no longer exists.');
    }
    stage = 'run_configuration';
    // The item's own config wins over `configSource`: a binding file's config is written
    // once for the install (`pack bindings --config`), a default for an item's first run,
    // not a change to this item's config.
    const found = await bindingItem(host, intent, identity.receiptId);
    const runConfig =
      (found ? itemRunConfig(found.item.key, found.runs) : undefined) ??
      (intent.launch.configSource
        ? await loadWorkflowRunConfigFile(intent.launch.configSource)
        : undefined);
    stage = 'launch_preparation';
    return await prepareBinding(host, intent, identity, found?.item ?? null, runConfig);
  } catch (error) {
    if (host.engineChanged?.())
      return await leaveForInstalledEngine(
        host.deps.store,
        identity,
        preparationStageFailure(stage),
        error
      );
    // Unknown failures are not an implicit retry policy; the receipt stays inspectable.
    // Configuration and provider errors can contain secret values, so persist the
    // failed boundary, not the exception text. A forge refusal and a missing file setting
    // are the exceptions: they hold only remote names, typed reasons, project configuration
    // and text written to be shown. The original cause reaches the caller.
    try {
      await host.deps.store.failStartBindingPreparation({
        ...identity,
        retryable: false,
        error: preparationStageFailure(stage),
        ...preparationRefusal(error, stage),
        ...(error instanceof ForgeRequirementError
          ? { forgeRefusal: { pack: error.packKey, failures: error.failures } }
          : {}),
      });
    } catch (statusError) {
      throw new AggregateError(
        [error, statusError],
        `Preparation ${preparationStageFailure(stage)}; recording the rejection also failed.`
      );
    }
    throw error;
  }
}

/** Why a rejected preparation refused its start, and the setting when a file names none. */
function preparationRefusal(error: unknown, stage: PreparationStage) {
  if (error instanceof FileSettingError)
    return { refusal: 'file_setting_missing', fileSetting: error.fileSetting } as const;
  if (error instanceof NoDefaultProviderError) return { refusal: 'no_default_provider' } as const;
  return { refusal: preparationStageFailure(stage) };
}

export interface ResourceStartHost extends WorkflowHost {
  /** The configured host identity. A host only prepares and admits work bound to it. */
  hostId: string;
  /** Start one admitted request: the CLI detaches it, the server runs it in-process unawaited. */
  startAdmitted: (requestId: string) => Promise<StartedExecutor | null>;
  /**
   * Whether the installed engine changed since this process loaded its code. A failed
   * preparation is then left pending for a current process (`leaveForInstalledEngine`).
   * Omitted by a host that cannot tell, which rejects failures as before.
   */
  engineChanged?: () => boolean;
}

/**
 * A preparation, dispatch, resource drain, or damaged receipt failure. Unknown or untrusted
 * receipt origins omit `receiptId`.
 */
export interface ResourceStartDrainFailure {
  receiptId?: string;
  error: unknown;
}

/**
 * A drain's failures, each tagged with the receipt it belongs to, so a caller that fired
 * one receipt reports its own failures apart from other pending work on the host.
 */
export class ResourceStartDrainError extends AggregateError {
  constructor(readonly failures: readonly ResourceStartDrainFailure[]) {
    super(
      failures.map(failure => failure.error),
      `${String(failures.length)} resource start operation(s) failed; inspect their receipts or resources.`
    );
    this.name = 'ResourceStartDrainError';
  }
}

function receiptIdOfLaunch(launch: PreparedWorkflowLaunch | undefined): string | undefined {
  return readResourceStartReceiptId(launch?.run.metadata);
}

/**
 * Prepare every pending binding of this host, or of `receiptIds` only, and start each one
 * admitted now. Each read lists from the oldest binding, one page further than the last,
 * until a read is not cut by its limit; a binding is tried once per call, so one that
 * stays pending (a retryable failure, another process's claim) cannot stall the pass.
 * Failures are collected, not thrown; a failed binding is not retried here.
 */
async function preparePendingBindings(
  host: ResourceStartHost,
  failures: ResourceStartDrainFailure[],
  pass: FollowPass,
  receiptIds?: readonly string[]
): Promise<void> {
  const PAGE = 100;
  const tried = new Set<string>();
  const key = (binding: PendingStartBindingInspection) =>
    'document' in binding ? binding.document : `${binding.receiptId}\n${binding.bindingId}`;
  // Receipt ids go to the store in chunks, so one query never binds more than a page of them.
  const chunks = receiptIds
    ? Array.from({ length: Math.ceil(receiptIds.length / PAGE) }, (_, index) =>
        receiptIds.slice(index * PAGE, (index + 1) * PAGE)
      )
    : [undefined];
  for (const chunk of chunks) {
    for (let limit = PAGE; ; limit += PAGE) {
      const listed = await host.deps.store.listPendingStartBindings({
        hostId: host.hostId,
        receiptIds: chunk,
        limit,
      });
      for (const binding of listed.filter(entry => !tried.has(key(entry)))) {
        tried.add(key(binding));
        await preparePendingBinding(host, failures, pass, binding);
      }
      // The limit counts bindings, not the damaged receipts reported beside them.
      if (listed.filter(entry => !('document' in entry)).length < limit) break;
    }
  }
}

async function preparePendingBinding(
  host: ResourceStartHost,
  failures: ResourceStartDrainFailure[],
  pass: FollowPass,
  binding: PendingStartBindingInspection
): Promise<void> {
  if ('document' in binding) return void failures.push({ error: binding.error });
  if (!binding.intent) return;
  const { receiptId, bindingId } = binding;
  const identity = { receiptId, bindingId, ownerId: randomUUID() };
  if (!(await host.deps.store.claimStartBindingPreparation(identity))) return;
  let disposition: PreparationResult;
  try {
    const intent = await followedIntent(host, pass, identity, {
      ...binding,
      intent: binding.intent,
    });
    if (!intent) return;
    disposition = await prepareClaimedBinding(host, intent, identity);
  } catch (error) {
    return void failures.push({ receiptId, error });
  }
  if (disposition.status === 'admitted')
    await startAdmittedRequest(host, failures, disposition.requestId, receiptId);
}

/** One drain pass's trigger directory, read at most once, and how a rebuild reads a cause. */
interface FollowPass {
  files: () => Promise<StartFiles>;
  reads: RebuildReads;
}

function followPass(host: ResourceStartHost): FollowPass {
  let files: Promise<StartFiles> | undefined;
  return {
    files: () => (files ??= readStartFiles(getTriggersPath())),
    reads: {
      store: host.deps.store,
      projectKeyOf: launchProjectKey(cwd =>
        registeredProjectKeyForPath(cwd, host.records.codebases)
      ),
      now: new Date(),
    },
  };
}

/** What a waiting start becomes before it is prepared or admitted (`waitingStart`). */
async function fateOf(
  host: ResourceStartHost,
  pass: FollowPass,
  binding: Pick<StartBindingInspection, 'receiptId' | 'bindingRevision'> & {
    intent: ResourceStartBindingIntent;
  }
): Promise<WaitingStartFate> {
  const receipt = await host.deps.store.getStartReceipt(binding.receiptId);
  if (!receipt) return { keep: true };
  return waitingStart({ ...binding, receipt }, await pass.files(), pass.reads);
}

/**
 * The intent a claimed pending binding prepares with: as frozen, or as its trigger file
 * builds it now, written to the binding. Undefined when its file refused it, recorded as
 * PR 6188's stop on the item. Throws, giving the claim back, when its file is unknown or
 * the rebuild cannot be written, so the next drain tries again.
 */
async function followedIntent(
  host: ResourceStartHost,
  pass: FollowPass,
  identity: BindingIdentity,
  binding: StartBindingInspection & { intent: ResourceStartBindingIntent }
): Promise<ResourceStartBindingIntent | undefined> {
  const { store } = host.deps;
  let fate: WaitingStartFate;
  try {
    fate = await fateOf(host, pass, binding);
    if ('unknown' in fate) throw fate.unknown;
    if (
      'intent' in fate &&
      !(await store.replaceStartBindingIntent({ ...identity, intent: fate.intent }))
    )
      throw new Error('Preparation ownership changed before the rebuilt binding was written.');
  } catch (error) {
    await store.resetStartBindingPreparation(identity);
    throw error;
  }
  if ('keep' in fate) return binding.intent;
  if ('intent' in fate) return fate.intent;
  // The detail names a trigger file, a source, a host and input names: no secret.
  log.info({ ...identity, ...fate.refused }, 'resource_start.binding_refused_by_file');
  await store.failStartBindingPreparation({
    ...identity,
    retryable: false,
    error: preparationStageFailure('launch_preparation'),
    refusal: fate.refused.reason,
  });
  return undefined;
}

/**
 * Send each queued request back to preparation whose trigger file no longer starts what it
 * was prepared from, before any is admitted. It keeps its launch when the file still
 * builds the same intent, revision aside, so a workflow-only change runs as prepared. The
 * pass's own preparation then rebuilds or refuses what it sent back; this is never the
 * place an intent is replaced or a start refused. Returns the requests it sent back.
 */
async function returnChangedQueuedStarts(
  host: ResourceStartHost,
  pass: FollowPass,
  queued: readonly QueuedResourceStartInspection[],
  failures: ResourceStartDrainFailure[]
): Promise<Set<string>> {
  const { store } = host.deps;
  const returned = new Set<string>();
  for (const request of queued) {
    const origin =
      'error' in request ? undefined : readResourceStartOrigin(request.launch.run.metadata);
    if (!origin) continue;
    try {
      const binding = (await store.getStartReceipt(origin.receiptId))?.bindings.find(
        entry => entry.bindingId === origin.bindingId
      );
      if (!binding?.intent) continue;
      const fate = await fateOf(host, pass, { ...binding, intent: binding.intent });
      if ('unknown' in fate) failures.push({ receiptId: origin.receiptId, error: fate.unknown });
      if ('keep' in fate || 'unknown' in fate) continue;
      if ('intent' in fate && sameStart(fate.intent, binding.intent)) continue;
      const launch = await store.returnQueuedStartToPreparation({
        requestId: request.id,
        ...origin,
      });
      if (!launch) continue;
      returned.add(request.id);
      log.info({ requestId: request.id, ...origin }, 'resource_start.queued_start_returned');
      await releaseQueuedLaunchSource(launch);
    } catch (error) {
      failures.push({ receiptId: origin.receiptId, error });
    }
  }
  return returned;
}

/** Whether two intents start the same thing, whatever revision each records. */
function sameStart(a: ResourceStartBindingIntent, b: ResourceStartBindingIntent): boolean {
  const plain = ({ bindingRevision: _revision, ...intent }: ResourceStartBindingIntent) =>
    JSON.parse(JSON.stringify(intent)) as unknown;
  return isDeepStrictEqual(plain(a), plain(b));
}

async function startAdmittedRequest(
  host: ResourceStartHost,
  failures: ResourceStartDrainFailure[],
  requestId: string,
  receiptId: string | undefined
): Promise<void> {
  try {
    await handOffAdmitted(host, requestId);
  } catch (error) {
    failures.push({ receiptId, error });
  }
}

/**
 * Whether the install hold is set. A host pass then prepares and drains nothing: its
 * bindings stay pending and its requests queued until the lift.
 */
async function heldPass(host: ResourceStartHost): Promise<boolean> {
  const hold = await host.deps.store.getInstallHold();
  // Debug, not info: a server takes a pass every few seconds for as long as the hold lasts.
  if (hold) log.debug({ hostId: host.hostId, setAt: hold.setAt }, 'resource_start.held');
  return hold !== null;
}

/**
 * Prepare every binding of `receiptIds` on this host and start those admitted now, leaving
 * the host's other work to its own drain: what an ending process does for the starts it caused.
 */
export async function startReceiptBindings(
  host: ResourceStartHost,
  receiptIds: ReadonlySet<string>
): Promise<void> {
  if (await heldPass(host)) return;
  const failures: ResourceStartDrainFailure[] = [];
  await preparePendingBindings(host, failures, followPass(host), [...receiptIds]);
  if (failures.length > 0) throw new ResourceStartDrainError(failures);
}

/**
 * One host pass: admit this host's queued requests while their slots have capacity, then
 * prepare all its pending receipt bindings, handing each admitted start to the host.
 * Queued requests go first because a new start yields to an older runnable request of its
 * host (`resourceStartBlocker`): after an install hold, a held `overlap: skip` binding
 * would otherwise be dropped behind requests the hold left undrained. A damaged receipt is
 * reported after the pass. Safe to run concurrently with other hosts and processes: the
 * store claims preparation and admission atomically.
 */
export async function drainResourceStartHost(host: ResourceStartHost): Promise<void> {
  if (await heldPass(host)) return;
  const failures: ResourceStartDrainFailure[] = [];
  const start = (requestId: string, receiptId?: string): Promise<void> =>
    startAdmittedRequest(host, failures, requestId, receiptId);

  const pass = followPass(host);
  const listed = await host.deps.store.listQueuedResourceStartsForHost(host.hostId);
  const returned = await returnChangedQueuedStarts(host, pass, listed, failures);
  const queued = listed.filter(request => !returned.has(request.id));
  const failed = new Set<string>();
  const drain = async (resource: string): Promise<boolean> => {
    let decisions: ResourceStartDisposition[];
    try {
      decisions = await host.deps.store.drainResourceStarts({ hostId: host.hostId, resource });
    } catch (error) {
      const receiptIds = new Set(
        queued
          .filter(request => request.resource === resource)
          .map(request =>
            'error' in request ? request.receiptId : receiptIdOfLaunch(request.launch)
          )
      );
      const failure = new Error(
        `Resource '${resource}' drain failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
      for (const receiptId of receiptIds) failures.push({ receiptId, error: failure });
      failed.add(resource);
      return false;
    }
    for (const decision of decisions) {
      if (decision.status === 'admitted') {
        // A queued request names its receipt in the run metadata written at preparation.
        const request = queued.find(item => item.id === decision.requestId);
        const launch = request && !('error' in request) ? request.launch : undefined;
        await start(decision.requestId, receiptIdOfLaunch(launch));
      }
    }
    return decisions.some(decision => decision.status === 'admitted');
  };
  // Under the run limit a resource's drain stops at the host's next start its decision admits
  // on another resource (`drainAdmits`), so the pass repeats while it admits anything.
  const resources = queuedDrainResources(queued, failures);
  for (let admitted = true; admitted; ) {
    admitted = false;
    for (const resource of resources)
      if (!failed.has(resource) && (await drain(resource))) admitted = true;
  }

  await preparePendingBindings(host, failures, pass);

  if (failures.length > 0) {
    throw new ResourceStartDrainError(failures);
  }
}

function queuedDrainResources(
  queued: readonly QueuedResourceStartInspection[],
  failures: ResourceStartDrainFailure[]
): string[] {
  for (const request of queued) {
    if (!('error' in request)) continue;
    failures.push({
      receiptId: request.receiptId,
      error: new Error(`Queued request '${request.id}' is invalid`, {
        cause: request.error,
      }),
    });
  }
  return [...new Set(queued.flatMap(request => ('error' in request ? [] : [request.resource])))];
}

export interface StartAdmittedResourceStartInput {
  requestId: string;
  hostId: string;
  host: WorkflowHost;
  /** Builds delivery for a run; correlation does not imply chat history. */
  createPlatform: (run: {
    runId: string;
    conversationId: string;
    origin: import('@archon/workflows/schemas/workflow-run').WorkflowRunOrigin | null;
  }) => IWorkflowPlatform;
  /**
   * Called once this process holds the run's exact live-owner lock, before the engine
   * claims the run. Returns the release called after the run settles. The CLI settles
   * the owned run on a graceful signal here; the server omits it because one process
   * hosts many runs and must not install process-wide handlers per run.
   */
  guardOwnedRun?: (owned: {
    runId: string;
    liveOwner: RunLiveOwner;
    getExecutionClaim: () => string | null | undefined;
  }) => () => void;
  /**
   * The PID of a detached process that executes only this run and leads its own process
   * group. Registering it lets `archon workflow cancel` terminate that tree. The server
   * omits it: its process hosts many runs and must never be the target of a stop.
   */
  detachedProcessPid?: number;
}

/**
 * Start one admitted pending run through the engine port. It is read again under its owner
 * lock, which cancel holds for a pending run; the engine's pending claim fences execution.
 *
 * Owned preparation errors fail only a still-pending run. Submission belongs to the
 * engine: a rejection there does not establish that execution never started.
 */
export async function startAdmittedResourceStart(
  input: StartAdmittedResourceStartInput
): Promise<WorkflowExecutionResult> {
  const { host } = input;
  const runId = (await loadAdmittedResourceStart(input)).run.id;
  const liveOwner = await startRunLiveOwner(runId, {
    detachedProcessPid: input.detachedProcessPid,
  });
  let ownedExecutionClaim: string | null | undefined;
  let releaseGuard: (() => void) | undefined;
  try {
    const { launch, run } = await loadAdmittedResourceStart(input);
    releaseGuard = input.guardOwnedRun?.({
      runId: run.id,
      liveOwner,
      getExecutionClaim: () => ownedExecutionClaim,
    });
    let submission: WorkflowEngineSubmitInput;
    try {
      submission = await prepareAdmittedResourceSubmission(input, { launch, run }, claim => {
        ownedExecutionClaim = claim;
      });
    } catch (error) {
      if (error instanceof TerminalStatusWriteError || liveOwner.isStopRequested()) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const { failed } = await requireTerminalStatusWrite(
        host.deps.store.failWorkflowRun(run.id, message, {
          pendingOnly: true,
          exitReason: 'launch_failed',
        }),
        { workflowRunId: run.id, site: 'resource_start.launch_failed', failure: error }
      );
      if (failed && error instanceof WorkflowCredentialPreflightError)
        return { success: false, workflowRunId: run.id, error: message };
      throw error;
    }
    return await host.engine.submit(submission);
  } finally {
    releaseGuard?.();
    await liveOwner.close().catch((error: unknown) => {
      log.error({ err: error as Error, runId }, 'resource_start.live_owner_close_failed');
    });
  }
}

async function prepareAdmittedResourceSubmission(
  input: StartAdmittedResourceStartInput,
  { launch, run }: Awaited<ReturnType<typeof loadAdmittedResourceStart>>,
  onExecutionClaimed: (claim: string | null) => void
): Promise<WorkflowEngineSubmitInput> {
  const { host } = input;
  const frozen = await resolveContinuationWorkflow(host.deps, run, launch.execution.cwd);
  if (!frozen) throw new Error(`Admitted run '${run.id}' has no frozen workflow source.`);
  const codebase = await host.records.codebases.getCodebase(launch.run.codebase_id);
  if (!codebase) throw new Error(`Admitted run '${run.id}' names a missing project.`);
  const platform = input.createPlatform({
    conversationId: launch.execution.conversationId,
    runId: run.id,
    origin: run.origin,
  });
  const sealed = readWorkflowRunConfigMetadata(run.metadata);
  const runConfig = sealed
    ? { runConfig: { layer: unsealWorkflowRunConfig(sealed), source: sealed.source } }
    : {};
  const deps = host.deps;
  const preparedAiConfiguration = await prepareRunAiConfiguration(
    deps,
    frozen.workflow,
    launch.execution.cwd,
    {
      configRoot: runProjectConfigRoot(run.metadata, launch.execution.cwd),
      aiConfigurationRun: run,
      inheritAiConfiguration: true,
      userId: run.user_id ?? undefined,
      codebaseId: codebase.id,
      ...runConfig,
    }
  );
  await assertRunCredentials(deps, preparedAiConfiguration, { cwd: launch.execution.cwd });
  const { lane, baseOverride } = await landingLane(host, codebase, run, launch.execution.isolation);
  const execution = await executionLane(host, {
    run,
    lane,
    startCommit: await definitionsStartCommit(run, codebase, baseOverride),
    codebase,
    cwd: launch.execution.cwd,
    platformType: platform.getPlatformType(),
    setupExecutor: createRunWorktreeSetupExecutor(host.deps, run, preparedAiConfiguration.config),
  });
  if (run.conversation_id)
    await host.records.conversations.updateConversation(run.conversation_id, {
      cwd: execution.cwd,
      codebase_id: codebase.id,
      isolation_env_id: execution.envId ?? null,
    });

  const baseBranch = codebase.default_branch?.trim() || undefined;
  return {
    platform,
    conversationId: launch.execution.conversationId,
    cwd: execution.cwd,
    workflow: frozen.workflow,
    userMessage: run.user_message ?? '',
    origin: run.origin ?? undefined,
    options: {
      preCreatedRun: run,
      onExecutionClaimed,
      preparedAiConfiguration,
      codebaseId: codebase.id,
      baseBranch,
      ownedWorktree: execution.ownedWorktree,
      ...(execution.cutFromCommit !== undefined ? { cutFromCommit: execution.cutFromCommit } : {}),
      resolvedBaseBranch: execution.resolvedBaseBranch,
      // A hand-off lane too: it keeps the handed-on checkout and proposes against the base.
      ...(baseOverride ? { baseOverride } : {}),
      resolveChildIsolation: createCodebaseChildResolver(
        host.records.isolation,
        codebase,
        {
          baseBranch,
          createdByPlatform: platform.getPlatformType(),
          createdByUserId: run.user_id ?? undefined,
        },
        host.deps
      ),
      // A fresh claim reseals caller configuration, so restore the one sealed at intake.
      ...runConfig,
    },
  };
}

/**
 * The prepared lane with the base the run takes. The item's landing branch outranks the
 * trigger file's static `baseOverride`, which is the same for every item the file starts.
 * Read now as well as at preparation, so a queued start whose item changed its branch while
 * it waited is refused (`definitionsStartCommit`) rather than run on definitions read from
 * another branch, and the persisted launch keeps its shape. A missing branch, or an in-place start
 * on an item that has one, refuses it here.
 */
async function landingLane(
  host: WorkflowHost,
  codebase: Codebase,
  run: { item_id: string | null },
  prepared: PreparedWorkflowLaunch['execution']['isolation']
): Promise<{ lane: PreparedWorkflowLaunch['execution']['isolation']; baseOverride?: string }> {
  let landing: string | undefined;
  if (run.item_id) {
    const item = await host.deps.store.getItem(run.item_id);
    if (!item) throw new Error(`The run's item '${run.item_id}' is missing from the store.`);
    const resolved = await resolveRunLanding(host.deps.store, codebase, item);
    // A hand-off lane is a worktree lane, so only a true in-place start reaches this.
    if (resolved && prepared.kind === 'in-place') refuseInPlaceLanding(item, resolved);
    landing = resolved?.branch;
  }
  if (prepared.kind !== 'worktree') return { lane: prepared };
  const baseOverride = landing ?? prepared.baseOverride;
  return baseOverride ? { lane: { ...prepared, baseOverride }, baseOverride } : { lane: prepared };
}

async function loadAdmittedResourceStart(input: StartAdmittedResourceStartInput) {
  const { host } = input;
  const request = await host.deps.store.getResourceStartRequest(input.requestId);
  if (request?.status !== 'admitted' || request.hostId !== input.hostId) {
    throw new Error('Execution requires an admitted request for this configured host.');
  }
  const { launch } = request;
  const run = await host.deps.store.getWorkflowRun(launch.run.id);
  if (run?.status !== 'pending') {
    throw new Error(`Admitted run '${launch.run.id}' is ${run?.status ?? 'missing'}, not pending.`);
  }
  return { launch, run };
}
