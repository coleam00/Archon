import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { toPersistedMessageMetadata } from '@archon/core/types';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from '@hono/zod-openapi';
import {
  drainResourceStartHost,
  isPreparationStageFailure,
  ResourceStartDrainError,
  startAdmittedResourceStart,
} from '@archon/core/workflows/resource-start-host';
import type { StartedExecutor } from '@archon/core/workflows/start-executor';
import { getTriggersPath } from '@archon/core/workflows/run-ended';
import { registeredProjectKeyForPath } from '@archon/core/services/codebase-checkout-resolver';
import { observeStartExecutor } from '@archon/core/services/run-attention-watch';
import { jsonValueSchema } from '@archon/workflows/output-ref';
import {
  awaitingExecution,
  SourceReceiptDigestConflictError,
  type AwaitingExecution,
  type StartBindingInspection,
} from '@archon/workflows/resource-start-store';
import {
  describeInstallHold,
  mappedItemKey,
  resourceStartBindingIntentSchema,
  RUN_SOURCE_ACTOR,
  requestingRun,
  type SourceReceiptInput,
  type TriggerConfig,
} from '@archon/workflows/schemas/resource-start';
import { assertItemKey } from '@archon/workflows/schemas/workflow-run';
import { releaseQueuedLaunchSource } from '@archon/core/workflows/queued-launch-source';
import { FileStoreUnsupportedError } from '@archon/workflows/file-store';
import { CLIAdapter } from '../adapters/cli-adapter';
import { drainFailureReasons } from '../utils/install-hosts';
import { writeJsonLine } from '../utils/stdout';
import {
  claimDetachedRunProcessOwner,
  DETACHED_RUN_OWNER_ENV,
} from '../utils/detached-run-control';
import { registerOwnedRunTermination } from '../utils/owned-run-termination';
import { addTriggerFile } from '../triggers/add-trigger-file';
import type { NativeScheduleOptions } from '../triggers/native-schedule';
import { fireConfig } from '../triggers/fire-binding-check';
import { resolveCliUserId } from './auth';
import { readCallingNode } from '../utils/calling-node';
import { requestedBy } from '../utils/requested-by';
import { checkTriggers } from './trigger-check';
import { scheduleTimer } from './trigger-schedule';

export { spawnAdmitted } from '../utils/spawn-admitted';

/** The input names a binding maps, for a message that tells the operator what to pass. */
function mappedNames(inputs: Readonly<Record<string, unknown>> | undefined): string {
  const names = Object.keys(inputs ?? {});
  return names.length === 0 ? 'it maps none' : names.join(', ');
}

async function loadFireConfig(path: string): Promise<TriggerConfig> {
  return fireConfig(JSON.parse(await readFile(path, 'utf8')) as unknown);
}

async function assertKnownRunAsUser(host: WorkflowHost, config: TriggerConfig): Promise<void> {
  if (!(await host.records.users.getUserById(config.binding.runAsUserId)))
    throw new Error('Trigger binding names an unknown run-as user.');
}

export function drainHost(
  host: WorkflowHost,
  hostId: string,
  dispatch: TriggerDispatch
): Promise<void> {
  return drainResourceStartHost({
    ...host,
    hostId,
    startAdmitted: requestId => dispatch(requestId, hostId),
  });
}

type TriggerOptions = {
  config?: string;
  host?: string;
  owner?: string;
  yes?: boolean;
  limit?: string;
  deliveryId?: string;
  inputs?: string;
  item?: string;
  noItem?: boolean;
};

/**
 * Hands an admitted request to its executor and names the process running it, or null when
 * the request already ran to its end in this call.
 */
export type TriggerDispatch = (
  requestId: string,
  hostId: string
) => Promise<StartedExecutor | null>;

async function triggerWhoami(host: WorkflowHost): Promise<void> {
  const cliId = resolveCliUserId();
  if (!cliId)
    throw new Error('Could not determine your CLI identity. Set ARCHON_USER_ID or $USER.');
  const user = await host.records.users.findOrCreateUserByPlatformIdentity('cli', cliId, cliId);
  if (!user) throw new FileStoreUnsupportedError('trigger identities');
  await writeJsonLine({ runAsUserId: user.id, cliIdentity: cliId });
}

/**
 * Each receipt, with `awaitingExecution`: its starts that are admitted but whose run no
 * executor has claimed, each with what this process observes of its executor (`state`).
 * One reads `unowned` only when nothing can be running it: its hand-off recorded that it
 * started nothing, or the process it was handed to is gone from this host;
 * `archon trigger execute <requestId> --host <hostId>` runs it once.
 * And `refusedBindings`: its bindings whose preparation failed or was refused, each with
 * the failed boundary and, for a refusal of the pack's forge needs, the reasons and remedies.
 * `hold` is the install hold when the receipt has a start it keeps (a binding not yet
 * prepared, or a queued request), else null. `runLimit` is the run limit while one of the
 * receipt's queued starts waits only for it (`RunLimitState.waiting`), else null.
 */
async function triggerList(host: WorkflowHost, options: TriggerOptions): Promise<void> {
  const receipts = await host.deps.store.listStartReceipts(
    options.limit === undefined ? undefined : Number(options.limit)
  );
  const hold = await host.deps.store.getInstallHold();
  const runLimit = await host.deps.store.getRunLimit();
  await writeJsonLine(
    await Promise.all(
      receipts.map(async receipt => {
        const bindings = (await host.deps.store.getStartReceipt(receipt.id))?.bindings ?? [];
        return {
          ...receipt,
          awaitingExecution: await receiptAwaitingExecution(host, bindings),
          refusedBindings: bindings
            .filter(binding => binding.status === 'rejected' || binding.status === 'failed')
            .map(({ bindingId, status, error, forgeRefusal }) => ({
              bindingId,
              status,
              error,
              forgeRefusal,
            })),
          hold: hold && bindings.some(heldBinding) ? hold : null,
          // The limit is read before the receipt, so a start a drain admitted in between is
          // still in `waiting`; only one that is still queued waits for it.
          runLimit: bindings.some(
            ({ requestStatus, disposition }) =>
              requestStatus === 'queued' && runLimit?.waiting.includes(disposition?.requestId ?? '')
          )
            ? runLimit && { limit: runLimit.limit, live: runLimit.live }
            : null,
        };
      })
    )
  );
}

function heldBinding(binding: StartBindingInspection): boolean {
  return (
    binding.status === 'pending' ||
    binding.status === 'failed' ||
    binding.requestStatus === 'queued'
  );
}

async function receiptAwaitingExecution(
  host: WorkflowHost,
  bindings: readonly StartBindingInspection[]
): Promise<AwaitingExecution[]> {
  const awaiting: AwaitingExecution[] = [];
  for (const binding of bindings) {
    if (binding.requestStatus !== 'admitted' || !binding.disposition) continue;
    const request = await host.deps.store.getResourceStartRequest(binding.disposition.requestId);
    const run = await host.deps.store.getWorkflowRun(binding.disposition.requestId);
    const waiting =
      run &&
      (await awaitingExecution(request, run, {
        observe: pending => observeStartExecutor(host.deps.store, pending),
      }));
    if (waiting) awaiting.push(waiting);
  }
  return awaiting;
}

/**
 * A fire from inside a workflow node records that run and node as the receipt's source
 * actor, so the started run and an operator can follow the chain. Outside a run: none.
 */
async function requestingSourceActor(
  host: WorkflowHost,
  env: NodeJS.ProcessEnv
): Promise<SourceReceiptInput['sourceActor']> {
  if (!env.WORKFLOW_ID) return null;
  const caller = readCallingNode(env.WORKFLOW_ID, env);
  if (!(await host.deps.store.getWorkflowRun(caller.runId)))
    throw new Error(
      `The CLI opened a different store than the engine: it does not know WORKFLOW_ID ${caller.runId}`
    );
  return { source: RUN_SOURCE_ACTOR, id: caller.runId, display: caller.nodePath };
}

/**
 * A fire from inside a run stays on that run's item; the root run of a sub-run holds it.
 * The item crosses the fire as its key and is resolved again in the new start's project,
 * so it is the caller's item only when that project is the item's. A start in another
 * project is refused here, where the fire still knows the item was not named: joining the
 * same key there would be a different item, and starting with none would drop the run
 * from the item's history.
 */
async function inheritedItemKey(
  host: WorkflowHost,
  sourceActor: SourceReceiptInput['sourceActor'],
  cwd: string
): Promise<string | undefined> {
  const caller = requestingRun(sourceActor);
  if (!caller) return undefined;
  const root =
    (await host.deps.store.getRunAncestry(caller.runId)).at(-1) ??
    (await host.deps.store.getWorkflowRun(caller.runId));
  const item = root?.item_id ? await host.deps.store.getItem(root.item_id) : null;
  if (!item) return undefined;
  const project = await registeredProjectKeyForPath(cwd, host.records.codebases);
  if (project === null)
    throw new Error(
      `This run is on item '${item.key}' in project '${item.projectKey}', but the fired start's checkout (${cwd}) is not a registered project, so it cannot be that item's project. The start cannot inherit the item: pass --item <key> to name its item there, or --no-item to start it on no item.`
    );
  if (project !== item.projectKey)
    throw new Error(
      `This run is on item '${item.key}' in project '${item.projectKey}', but the fired start runs in project '${project}'. An item belongs to one project, so the start cannot inherit it: pass --item <key> to name its item there, or --no-item to start it on no item.`
    );
  return item.key;
}

function assertItemOptions(options: TriggerOptions): void {
  if (options.item === undefined) return;
  if (options.noItem) throw new Error('--item and --no-item are mutually exclusive.');
  assertItemKey(options.item);
}

/**
 * The item a fire's start is on: `--item` first, none with `--no-item`, then the
 * binding's `item` mapping read from `--inputs`, then the calling run's item, read through
 * `inherited` only when nothing before it decides. A binding that maps its item never
 * inherits one, and a fire whose inputs cannot name the item is refused before anything
 * is recorded. A recorded delivery keeps its first acceptance's item, so only `--item` and
 * `--no-item` are read for it.
 */
export async function fireItemKey(fire: {
  config: TriggerConfig;
  explicit: string | undefined;
  noItem: boolean;
  eventInputs: Readonly<Record<string, unknown>> | undefined;
  recorded: boolean;
  inherited: () => Promise<string | undefined>;
}): Promise<string | undefined> {
  const { config } = fire;
  if (fire.noItem) return undefined;
  if (fire.explicit !== undefined || fire.recorded) return fire.explicit;
  if (config.item === undefined) return fire.inherited();
  const inputs = fire.eventInputs ?? {};
  const mapped = mappedItemKey(
    config.item,
    Object.hasOwn(inputs, config.item.field) ? inputs[config.item.field] : undefined
  );
  if (!mapped.ok)
    throw new Error(
      `Binding '${config.binding.bindingId}' names its item from the fire's --inputs, but its ${mapped.reason}. Nothing was recorded or started.`
    );
  return mapped.key;
}

async function triggerFire(
  host: WorkflowHost,
  options: TriggerOptions,
  dispatch: TriggerDispatch,
  env: NodeJS.ProcessEnv,
  wait: PreparationWait
): Promise<void> {
  if (!options.config) throw new Error('Usage: archon trigger fire --config <timer-binding.json>');
  if (options.deliveryId !== undefined && options.deliveryId.length === 0)
    throw new Error('--delivery-id must not be empty.');
  let eventInputs: z.infer<typeof resourceStartBindingIntentSchema>['eventInputs'];
  if (options.inputs !== undefined) {
    try {
      eventInputs = z
        .record(z.string().min(1), jsonValueSchema)
        .parse(JSON.parse(await readFile(options.inputs, 'utf8')) as unknown);
    } catch (error) {
      throw new Error(
        '--inputs must name a readable file containing a JSON object with non-empty input names.',
        { cause: error }
      );
    }
  }
  assertItemOptions(options);
  const config = await loadFireConfig(options.config);
  // A fire has no ended or asking run to take the checkout from; starting the stage anyway would
  // cut it from the base branch, which is the one place this binding must never run.
  if (config.on?.runEnded?.checkout !== undefined)
    throw new Error(
      `${options.config} takes its checkout from the run that ended (on.runEnded.checkout), so a fire has none to give it. To start '${config.binding.launch.workflowName}' on a run's checkout by hand, run archon workflow run ${config.binding.launch.workflowName} --adopt <run-id> --item <key>, naming the run that holds the branch: after a read-only check, the run in the check's metadata.checkout_handoff.runId (archon workflow get <check-run-id> --json), not the check.`
    );
  if (config.on?.asksSettled?.checkout !== undefined)
    throw new Error(
      `${options.config} takes its checkout from the run that left the asks (on.asksSettled.checkout), so a fire has none to give it. To start '${config.binding.launch.workflowName}' on that checkout by hand, run archon workflow run ${config.binding.launch.workflowName} --adopt <holder-run-id> --item <key>, naming the run that holds the checkout: metadata.asks_checkout.handoff.runId in archon workflow get <asking-run-id> --json, which after a read-only asking stage is the run it was given, not the asking run. When asks_checkout records a refusal, or none, no checkout is left: run the asking workflow again on the item. Pass an --input <name>=<value> for each input the file maps (${mappedNames(config.on.asksSettled.inputs)}): --adopt carries the checkout, not the answers. Read the answers from archon workflow runs --item <key> --json (its answers of kind 'ask': the asking run's for an input read from { answers: true }, all of them for { item: answers }) and the asking run's inputs from archon workflow get <asking-run-id> --json.`
    );
  const sourceActor = await requestingSourceActor(host, env);
  // A redelivery keeps the binding snapshot of its first acceptance, so today's users
  // must not turn a recorded delivery into a failure; the store answers replay or
  // conflict for it. This lookup is the only run-as gate before persistence. It holds
  // because receipts are never deleted: retention would let a vanished receipt pass
  // here as an unvalidated first acceptance.
  const recorded =
    options.deliveryId !== undefined &&
    (await host.deps.store.hasStartReceiptForDelivery(config.sourceInstanceId, options.deliveryId));
  if (!recorded) await assertKnownRunAsUser(host, config);
  const itemKey = await fireItemKey({
    config,
    explicit: options.item,
    noItem: options.noItem === true,
    eventInputs,
    recorded,
    inherited: () => inheritedItemKey(host, sourceActor, config.binding.launch.cwd),
  });
  const binding = {
    ...config.binding,
    ...(eventInputs !== undefined ? { eventInputs } : {}),
    bindingRevision: createHash('sha256').update(JSON.stringify(config.binding)).digest('hex'),
  };
  const receipt = await host.deps.store
    .acceptStartReceipt({
      receipt: {
        id: randomUUID(),
        sourceInstanceId: config.sourceInstanceId,
        deliveryId: options.deliveryId ?? null,
        contentDigest: createHash('sha256')
          .update(JSON.stringify(options.deliveryId === undefined ? config : (eventInputs ?? {})))
          .digest('hex'),
        receivedAt: new Date().toISOString(),
        occurredAt: null,
        sourceActor,
        ...(itemKey === undefined ? {} : { itemKey }),
      },
      outcome: 'matched',
      bindings: [binding],
    })
    .catch((error: unknown) => {
      if (error instanceof SourceReceiptDigestConflictError)
        throw new Error(
          `Delivery ID '${options.deliveryId}' was already used with different inputs`,
          { cause: error }
        );
      throw error;
    });
  await drainReceipt(host, receipt.receiptId, dispatch);
  await awaitOthersPreparation(host, receipt, wait);
  await writeFiredReceipt(host, receipt.receiptId);
}

/**
 * How long `fire` waits for another process preparing its binding. Bounded because a
 * stopped owner looks the same as a slow one; past it the fire changes nothing and names
 * the owner.
 */
const PREPARATION_WAIT: PreparationWait = { intervalMs: 250, timeoutMs: 60_000 };

type PreparationWait = { intervalMs: number; timeoutMs: number };

/**
 * Another process's drain can claim the binding this fire just accepted, so the fire's own
 * drain leaves it alone. Wait for that preparation to end, so the fire reports its outcome
 * and fails as it would had it prepared the binding itself. A replay reports what is stored.
 */
async function awaitOthersPreparation(
  host: WorkflowHost,
  receipt: { receiptId: string; replay: boolean },
  wait: PreparationWait
): Promise<void> {
  const { receiptId } = receipt;
  const deadline = Date.now() + wait.timeoutMs;
  for (;;) {
    const retained = await host.deps.store.getStartReceipt(receiptId);
    const bindings = retained?.bindings ?? [];
    const preparing = bindings.filter(binding => binding.status === 'preparing');
    if (preparing.length === 0) {
      // This fire's own preparation failure already failed its drain.
      const failed = receipt.replay
        ? undefined
        : bindings.find(binding => isPreparationStageFailure(binding.error));
      if (failed)
        throw new Error(
          `Receipt ${receiptId} is retained, but another process's preparation of binding ${failed.bindingId} failed at ${failed.error}. Inspect that receipt before recovery.`
        );
      return;
    }
    if (Date.now() >= deadline) {
      for (const binding of preparing)
        process.stderr.write(
          `Another process (preparation owner ${binding.ownerId}) is still preparing binding ${binding.bindingId} of receipt ${receiptId}. If that process has stopped, run archon trigger recover-preparation ${receiptId} ${binding.bindingId} --owner ${binding.ownerId} --yes, then drain the host.\n`
        );
      return;
    }
    await Bun.sleep(wait.intervalMs);
  }
}

/** The fired receipt, with the install hold when it keeps one of the receipt's starts. */
async function writeFiredReceipt(host: WorkflowHost, receiptId: string): Promise<void> {
  const retained = await host.deps.store.getStartReceipt(receiptId);
  const hold = await host.deps.store.getInstallHold();
  // A replayed delivery admitted before the hold has nothing held.
  const held = hold && retained?.bindings.some(heldBinding) ? hold : null;
  if (held)
    process.stderr.write(
      `New runs are held on this install (${describeInstallHold(held)}); this start waits until the hold is lifted.\n`
    );
  for (const binding of retained?.bindings ?? []) {
    const note = admittedStartNote(binding.disposition);
    if (note) process.stderr.write(`${note}\n`);
  }
  await writeJsonLine(retained && { ...retained, hold: held });
}

/**
 * Admission checks what it can before a slot is taken, but the checkout is prepared
 * when the run starts, in its own process. Say so, so an admitted receipt is not read
 * as a run that is ready and cannot fail before its first node.
 */
function admittedStartNote(disposition: StartBindingInspection['disposition']): string | null {
  const why =
    'its checkout is prepared when it starts, and that can still fail before its first node, for example on a base branch the remote does not have';
  if (disposition?.status === 'admitted')
    return `Run ${disposition.runId} is admitted; ${why}. Watch it with \`archon workflow get ${disposition.runId}\`.`;
  if (disposition?.status === 'queued')
    return `Request ${disposition.requestId} is queued; when it starts, ${why}. Watch it with \`archon trigger inspect ${disposition.requestId}\`.`;
  return null;
}

async function drainReceipt(
  host: WorkflowHost,
  receiptId: string,
  dispatch: TriggerDispatch
): Promise<void> {
  try {
    const retained = await host.deps.store.getStartReceipt(receiptId);
    if (!retained || retained.bindings.length === 0)
      throw new Error('The retained receipt has no binding host.');
    const hostIds = retained.bindings.map(binding => {
      if (!binding.hostId) throw new Error('The retained binding has no execution host.');
      return binding.hostId;
    });
    for (const hostId of new Set(hostIds)) await drainHost(host, hostId, dispatch);
  } catch (error) {
    if (!(error instanceof ResourceStartDrainError)) {
      throw new Error(
        `Receipt ${receiptId} is retained, but its host drain failed: ${drainFailureReasons([error])}. Inspect that receipt before recovery.`,
        { cause: error }
      );
    }
    // Other pending work on the host can fail in the same drain; only this receipt's
    // failures are this command's failure.
    const others = error.failures.filter(failure => failure.receiptId !== receiptId);
    const own = error.failures.filter(failure => !others.includes(failure));
    if (own.length > 0)
      throw new Error(
        `Receipt ${receiptId} is retained, but its host drain failed: ${drainFailureReasons(own.map(failure => failure.error))}. Inspect that receipt before recovery.`,
        { cause: error }
      );
    process.stderr.write(
      `Warning: ${String(others.length)} other or unattributed start operation(s) on this host failed while draining receipt ${receiptId}: ${drainFailureReasons(others.map(failure => failure.error))}\n`
    );
  }
}

async function triggerDrain(
  host: WorkflowHost,
  options: TriggerOptions,
  dispatch: TriggerDispatch
): Promise<void> {
  if (!options.host) throw new Error('Usage: archon trigger drain --host <configured-host>');
  const hold = await host.deps.store.getInstallHold();
  if (hold) {
    process.stderr.write(
      `New runs are held on this install (${describeInstallHold(hold)}); nothing was drained. Run archon hold lift to start what it keeps.\n`
    );
    await writeJsonLine({ hostId: options.host, drained: false, hold });
    return;
  }
  await drainHost(host, options.host, dispatch);
  await writeJsonLine({ hostId: options.host, drained: true, hold: null });
}

async function triggerExecute(
  host: WorkflowHost,
  args: string[],
  options: TriggerOptions
): Promise<void> {
  if (!args[0] || !options.host)
    throw new Error('Usage: archon trigger execute <admitted-request-id> --host <configured-host>');
  // Read the marker `spawnAdmitted` sets, then clear it before any node subprocess
  // can inherit it. Only a marked process that holds what `archon workflow cancel`
  // terminates (its own process group, or on Windows its job object) registers its PID.
  const detachedProcessOwner = process.env[DETACHED_RUN_OWNER_ENV] === '1';
  if (detachedProcessOwner) {
    Reflect.deleteProperty(process.env, DETACHED_RUN_OWNER_ENV);
    await claimDetachedRunProcessOwner();
  }
  const { deps } = host;
  const result = await startAdmittedResourceStart({
    requestId: args[0],
    hostId: options.host,
    host,
    createPlatform: ({ origin }) => {
      const conversationDbId = origin?.conversationId;
      return new CLIAdapter({
        recordMessage: conversationDbId
          ? async (_id, message, metadata): Promise<void> => {
              await host.records.messages.addMessage(
                conversationDbId,
                'assistant',
                message,
                toPersistedMessageMetadata(metadata)
              );
            }
          : undefined,
      });
    },
    guardOwnedRun: owned =>
      registerOwnedRunTermination({
        store: deps.store,
        ...owned,
        logModule: 'cli.trigger',
        detachedProcessOwner,
      }),
    ...(detachedProcessOwner ? { detachedProcessPid: process.pid } : {}),
  });
  if (!result.success) throw new Error(`Run ${args[0]} did not complete: ${result.error}`);
}

async function inspectedRun(host: WorkflowHost, runId: string) {
  const run = await host.deps.store.getWorkflowRun(runId);
  return run
    ? {
        id: run.id,
        status: run.status,
        error: typeof run.metadata.error === 'string' ? run.metadata.error : null,
        inspectCommand: `archon workflow get ${run.id}`,
      }
    : null;
}

async function triggerInspect(host: WorkflowHost, args: string[]): Promise<void> {
  if (!args[0]) throw new Error('Usage: archon trigger inspect <receipt-or-request-id>');
  const value =
    (await host.deps.store.getStartReceipt(args[0])) ??
    (await host.deps.store.getResourceStartRequest(args[0]));
  if (!value) throw new Error('Trigger receipt or request not found.');
  if (!('launch' in value)) {
    await writeJsonLine({
      ...value,
      bindings: await Promise.all(
        value.bindings.map(async binding => ({
          ...binding,
          run:
            binding.disposition?.status === 'admitted'
              ? await inspectedRun(host, binding.disposition.runId)
              : null,
        }))
      ),
    });
    return;
  }
  const runId =
    value.status === 'admitted'
      ? value.launch.run.id
      : value.blocker?.kind === 'run'
        ? value.blocker.id
        : null;
  await writeJsonLine({
    ...value,
    requestedBy: await requestedBy(host, value.launch.run.metadata),
    run: runId
      ? {
          ...(value.status === 'admitted' ? await inspectedRun(host, runId) : {}),
          id: runId,
          status: value.status === 'admitted' ? value.runStatus : value.blockerRunStatus,
          inspectCommand: `archon workflow get ${runId}`,
          recovery: {
            ...(value.status === 'admitted' && value.runStatus === 'pending'
              ? {
                  retryPendingArgv: [
                    'archon',
                    'trigger',
                    'execute',
                    value.id,
                    '--host',
                    value.hostId,
                  ],
                  // A retry runs in the foreground, not as a detached owner, so
                  // `archon workflow cancel` can't reach it; its own signal handler can.
                  retryStop:
                    'The retry runs in the foreground. Stop it with Ctrl-C (SIGINT) in that terminal; it settles the run it owns.',
                }
              : {}),
            prerequisite:
              'Verify the exact execution owner and its descendants have stopped. Age or an unreachable endpoint is not proof.',
            abandonCommand: `archon workflow abandon ${runId}`,
          },
        }
      : null,
  });
}

async function recoverTriggerPreparation(
  host: WorkflowHost,
  args: string[],
  options: TriggerOptions
): Promise<void> {
  if (!args[0] || !args[1] || !options.owner || !options.yes)
    throw new Error(
      'After confirming the exact preparation owner is stopped: archon trigger recover-preparation <receipt-id> <binding-id> --owner <recorded-owner-id> --yes'
    );
  const reset = await host.deps.store.resetStartBindingPreparation({
    receiptId: args[0],
    bindingId: args[1],
    ownerId: options.owner,
  });
  if (!reset)
    throw new Error('Preparation ownership no longer matches; inspect the receipt again.');
  await writeJsonLine({ recovered: true });
}

async function withdrawTrigger(host: WorkflowHost, args: string[]): Promise<void> {
  if (!args[0]) throw new Error('Usage: archon trigger withdraw <queued-request-id>');
  const withdrawn = await host.deps.store.withdrawQueuedResourceStart(args[0]);
  if (!withdrawn) throw new Error('Only untouched queued requests can be withdrawn.');
  const { launch } = withdrawn;
  // An unreadable launch names no source to remove; the request no longer holds the queue.
  if (launch === null) {
    await writeJsonLine({ requestId: args[0], withdrawn: true, launch: 'unreadable' });
    return;
  }
  try {
    await releaseQueuedLaunchSource(launch);
  } catch (error) {
    throw new Error(`Request withdrawn, but ${(error as Error).message}`, { cause: error });
  }
  await writeJsonLine({ requestId: args[0], withdrawn: true });
}

async function scheduleTrigger(
  host: WorkflowHost,
  args: string[],
  options: TriggerOptions,
  schedules: NativeScheduleOptions
): Promise<void> {
  const operation = args[0];
  if (
    !options.config ||
    (operation !== 'install' && operation !== 'remove' && operation !== 'status')
  )
    throw new Error(
      'Usage: archon trigger schedule <install|remove|status> --config <timer-binding.json>'
    );
  const config = await loadFireConfig(options.config);
  await scheduleTimer({
    operation,
    config,
    configPath: resolve(options.config),
    schedules,
    assertKnownRunAsUser: () => assertKnownRunAsUser(host, config),
  });
}

async function addTrigger(args: string[]): Promise<void> {
  const [file, ...rest] = args;
  if (file === undefined || rest.length > 0) throw new Error('Usage: archon trigger add <file>');
  await writeJsonLine({ added: await addTriggerFile(resolve(file), getTriggersPath()) });
}

export interface TriggerDependencies {
  /** Hands an admitted request to its executor; by default `trigger execute` in this process. */
  dispatch?: TriggerDispatch;
  /** The environment `fire` reads the calling node's identity from; by default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The scheduler `check` and `schedule` use; by default this host's. */
  schedules?: NativeScheduleOptions;
  /** How long `fire` waits for another process preparing its binding; by default a minute. */
  preparationWait?: PreparationWait;
}

export async function triggerCommand(
  host: WorkflowHost,
  action: string | undefined,
  args: string[],
  options: TriggerOptions,
  dependencies: TriggerDependencies = {}
): Promise<void> {
  const dispatch: TriggerDispatch =
    dependencies.dispatch ??
    (async (requestId, hostId) => {
      // Runs in the foreground to its end, so nothing is left to record as starting.
      await triggerCommand(host, 'execute', [requestId], { host: hostId });
      return null;
    });
  switch (action) {
    case 'whoami':
      return triggerWhoami(host);
    case 'list':
      return triggerList(host, options);
    case 'add':
      return addTrigger(args);
    case 'check':
      return checkTriggers(host, dependencies.schedules ?? {});
    case 'fire':
      return triggerFire(
        host,
        options,
        dispatch,
        dependencies.env ?? process.env,
        dependencies.preparationWait ?? PREPARATION_WAIT
      );
    case 'drain':
      return triggerDrain(host, options, dispatch);
    case 'execute':
      return triggerExecute(host, args, options);
    case 'inspect':
      return triggerInspect(host, args);
    case 'recover-preparation':
      return recoverTriggerPreparation(host, args, options);
    case 'withdraw':
      return withdrawTrigger(host, args);
    case 'schedule':
      return scheduleTrigger(host, args, options, dependencies.schedules ?? {});
    default:
      throw new Error(
        'Usage: archon trigger <fire|drain|execute|list|add|check|inspect|withdraw|recover-preparation|schedule|whoami>'
      );
  }
}
