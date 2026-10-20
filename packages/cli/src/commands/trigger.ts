import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { toPersistedMessageMetadata } from '@archon/core/types';
import { cliProgramArguments } from '../utils/cli-program-arguments';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from '@hono/zod-openapi';
import { getArchonHome } from '@archon/paths';
import {
  drainResourceStartHost,
  ResourceStartDrainError,
  startAdmittedResourceStart,
} from '@archon/core/workflows/resource-start-host';
import { sanitizeCredentials } from '@archon/core/utils/credential-sanitizer';
import {
  collectCredentialValues,
  redactCredentialValues,
} from '@archon/paths/credential-redaction';
import { jsonValueSchema } from '@archon/workflows/output-ref';
import { SourceReceiptDigestConflictError } from '@archon/workflows/resource-start-store';
import { resourceStartBindingIntentSchema } from '@archon/workflows/schemas/resource-start';
import { readWorkflowSourceState } from '@archon/workflows/schemas/workflow-run';
import { FileStoreUnsupportedError } from '@archon/workflows/file-store';
import { CLIAdapter } from '../adapters/cli-adapter';
import { writeJsonLine } from '../utils/stdout';
import {
  assertDetachedRunProcessOwner,
  DETACHED_RUN_OWNER_ENV,
} from '../utils/detached-run-control';
import { registerOwnedRunTermination } from '../utils/owned-run-termination';
import { installMacosNativeSchedule, removeMacosNativeSchedule } from '../triggers/native-schedule';
import { resolveCliUserId } from './auth';

export const timerTriggerConfigSchema = z
  .object({
    version: z.literal(1),
    sourceInstanceId: z.string().min(1),
    binding: resourceStartBindingIntentSchema.omit({ eventInputs: true }),
    schedule: z
      .object({ intervalSeconds: z.number().int().positive(), runAtLoad: z.boolean() })
      .strict(),
  })
  .strict();

async function loadTimerConfig(path: string): Promise<z.infer<typeof timerTriggerConfigSchema>> {
  const value = timerTriggerConfigSchema.safeParse(
    JSON.parse(await readFile(path, 'utf8')) as unknown
  );
  if (!value.success)
    throw new Error(
      `Invalid timer configuration fields: ${value.error.issues.map(issue => issue.path.join('.')).join(', ')}`
    );
  if (!isAbsolute(value.data.binding.launch.cwd))
    throw new Error('Trigger execution cwd must be absolute.');
  return value.data;
}

async function assertKnownRunAsUser(
  host: WorkflowHost,
  config: z.infer<typeof timerTriggerConfigSchema>
): Promise<void> {
  if (!(await host.records.users.getUserById(config.binding.runAsUserId)))
    throw new Error('Trigger binding names an unknown run-as user.');
}

/** Hand one admitted request to a detached `trigger execute` process with its own log. */
export async function spawnAdmitted(
  host: WorkflowHost,
  requestId: string,
  hostId: string
): Promise<void> {
  const request = await host.deps.store.getResourceStartRequest(requestId);
  if (request?.status !== 'admitted') throw new Error('The admitted start request is unavailable.');
  const [executable, ...prefix] = cliProgramArguments();
  const logDirectory = join(getArchonHome(), 'logs');
  await mkdir(logDirectory, { recursive: true });
  const log = await open(join(logDirectory, `trigger-run-${requestId}.log`), 'a', 0o600);
  try {
    const child = spawn(
      executable,
      [...prefix, 'trigger', 'execute', requestId, '--host', hostId],
      {
        cwd: request.launch.execution.cwd,
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
        windowsHide: true,
        env: { ...process.env, ARCHON_HOME: getArchonHome(), [DETACHED_RUN_OWNER_ENV]: '1' },
      }
    );
    await new Promise<void>((resolveSpawn, reject) => {
      child.once('error', reject);
      child.once('spawn', resolveSpawn);
    });
    child.unref();
  } finally {
    await log.close();
  }
}

/**
 * The messages behind drain failures, for the operator's terminal. The store keeps only
 * the failed stage because configuration and provider errors can carry credentials, so
 * the text is redacted with the same policy as subprocess output before it is shown.
 * Flattens the nested `AggregateError`s the drain builds, which carry no reason of their own.
 */
function drainFailureReasons(errors: readonly unknown[]): string {
  const messages = (error: unknown): string[] =>
    error instanceof AggregateError
      ? error.errors.flatMap(messages)
      : [error instanceof Error ? error.message : String(error)];
  const credentials = collectCredentialValues(process.env);
  return errors
    .flatMap(messages)
    .map(message => sanitizeCredentials(redactCredentialValues(message, credentials)))
    .join('; ');
}

function drainHost(
  host: WorkflowHost,
  hostId: string,
  dispatch: (requestId: string, hostId: string) => Promise<void>
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
};

type TriggerDispatch = (requestId: string, hostId: string) => Promise<void>;

async function triggerWhoami(host: WorkflowHost): Promise<void> {
  const cliId = resolveCliUserId();
  if (!cliId)
    throw new Error('Could not determine your CLI identity. Set ARCHON_USER_ID or $USER.');
  const user = await host.records.users.findOrCreateUserByPlatformIdentity('cli', cliId, cliId);
  if (!user) throw new FileStoreUnsupportedError('trigger identities');
  await writeJsonLine({ runAsUserId: user.id, cliIdentity: cliId });
}

async function triggerList(host: WorkflowHost, options: TriggerOptions): Promise<void> {
  await writeJsonLine(
    await host.deps.store.listStartReceipts(
      options.limit === undefined ? undefined : Number(options.limit)
    )
  );
}

async function triggerFire(
  host: WorkflowHost,
  options: TriggerOptions,
  dispatch: TriggerDispatch
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
  const config = await loadTimerConfig(options.config);
  // A redelivery keeps the binding snapshot of its first acceptance, so today's users
  // must not turn a recorded delivery into a failure; the store answers replay or
  // conflict for it. This lookup is the only run-as gate before persistence. It holds
  // because receipts are never deleted: retention would let a vanished receipt pass
  // here as an unvalidated first acceptance.
  const recorded =
    options.deliveryId !== undefined &&
    (await host.deps.store.hasStartReceiptForDelivery(config.sourceInstanceId, options.deliveryId));
  if (!recorded) await assertKnownRunAsUser(host, config);
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
        sourceActor: null,
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
  await writeJsonLine(await host.deps.store.getStartReceipt(receipt.receiptId));
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
    // A failure with no receipt id could be this one, so it counts as ours.
    const others = error.failures.filter(
      failure => failure.receiptId !== undefined && failure.receiptId !== receiptId
    );
    const own = error.failures.filter(failure => !others.includes(failure));
    if (own.length > 0)
      throw new Error(
        `Receipt ${receiptId} is retained, but its host drain failed: ${drainFailureReasons(own.map(failure => failure.error))}. Inspect that receipt before recovery.`,
        { cause: error }
      );
    process.stderr.write(
      `Warning: ${String(others.length)} other start(s) on this host failed and are not part of receipt ${receiptId}: ${drainFailureReasons(others.map(failure => failure.error))}\n`
    );
  }
}

async function triggerDrain(
  host: WorkflowHost,
  options: TriggerOptions,
  dispatch: TriggerDispatch
): Promise<void> {
  if (!options.host) throw new Error('Usage: archon trigger drain --host <configured-host>');
  await drainHost(host, options.host, dispatch);
  await writeJsonLine({ hostId: options.host, drained: true });
}

async function triggerExecute(
  host: WorkflowHost,
  args: string[],
  options: TriggerOptions
): Promise<void> {
  if (!args[0] || !options.host)
    throw new Error('Usage: archon trigger execute <admitted-request-id> --host <configured-host>');
  // Read the marker `spawnAdmitted` sets, then clear it before any node subprocess
  // can inherit it. Only a marked process that leads its own process group registers
  // its PID, because `archon workflow cancel` terminates that whole group.
  const detachedProcessOwner = process.env[DETACHED_RUN_OWNER_ENV] === '1';
  if (detachedProcessOwner) {
    Reflect.deleteProperty(process.env, DETACHED_RUN_OWNER_ENV);
    assertDetachedRunProcessOwner();
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
        endNodeProcessTrees: !detachedProcessOwner,
      }),
    ...(detachedProcessOwner ? { detachedProcessPid: process.pid } : {}),
  });
  if (!result.success) throw new Error(`Run ${args[0]} did not complete: ${result.error}`);
}

async function triggerInspect(host: WorkflowHost, args: string[]): Promise<void> {
  if (!args[0]) throw new Error('Usage: archon trigger inspect <receipt-or-request-id>');
  const value =
    (await host.deps.store.getStartReceipt(args[0])) ??
    (await host.deps.store.getResourceStartRequest(args[0]));
  if (!value) throw new Error('Trigger receipt or request not found.');
  if (!('launch' in value)) {
    await writeJsonLine(value);
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
    run: runId
      ? {
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
  const request = await host.deps.store.getResourceStartRequest(args[0]);
  if (!request || !(await host.deps.store.withdrawQueuedResourceStart(args[0])))
    throw new Error('Only untouched queued requests can be withdrawn.');
  const source = readWorkflowSourceState(request.launch.run.metadata);
  if (source.kind === 'recorded') await rm(source.record.root, { recursive: true, force: true });
  if (source.kind === 'unreadable')
    throw new Error(
      'Request withdrawn, but its source record is unreadable; inspect storage before cleanup.'
    );
  await writeJsonLine({ requestId: args[0], withdrawn: true });
}

async function scheduleTrigger(
  host: WorkflowHost,
  args: string[],
  options: TriggerOptions
): Promise<void> {
  if (!options.config || !['install', 'remove'].includes(args[0] ?? ''))
    throw new Error(
      'Usage: archon trigger schedule <install|remove> --config <timer-binding.json>'
    );
  const config = await loadTimerConfig(options.config);
  if (args[0] !== 'remove') await assertKnownRunAsUser(host, config);
  const scheduleId = createHash('sha256')
    .update(JSON.stringify([getArchonHome(), config.sourceInstanceId, config.binding.bindingId]))
    .digest('hex');
  if (args[0] === 'remove') await removeMacosNativeSchedule(scheduleId);
  else {
    const [executable, ...prefix] = cliProgramArguments();
    await installMacosNativeSchedule({
      id: scheduleId,
      programArguments: [
        executable,
        ...prefix,
        'trigger',
        'fire',
        '--config',
        resolve(options.config),
      ],
      workingDirectory: config.binding.launch.cwd,
      archonHome: getArchonHome(),
      schedule: config.schedule,
    });
  }
  await writeJsonLine({ bindingId: config.binding.bindingId, schedule: args[0] });
}

export async function triggerCommand(
  host: WorkflowHost,
  action: string | undefined,
  args: string[],
  options: TriggerOptions,
  dispatch: TriggerDispatch = (requestId, hostId) =>
    triggerCommand(host, 'execute', [requestId], { host: hostId })
): Promise<void> {
  switch (action) {
    case 'whoami':
      return triggerWhoami(host);
    case 'list':
      return triggerList(host, options);
    case 'fire':
      return triggerFire(host, options, dispatch);
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
      return scheduleTrigger(host, args, options);
    default:
      throw new Error(
        'Usage: archon trigger <fire|drain|execute|list|inspect|withdraw|recover-preparation|schedule|whoami>'
      );
  }
}
