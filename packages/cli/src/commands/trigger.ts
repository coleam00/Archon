import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from '@hono/zod-openapi';
import { BUNDLED_IS_BINARY, getArchonHome } from '@archon/paths';
import {
  acceptStartReceipt,
  claimStartBindingPreparation,
  completeStartBindingPreparation,
  drainResourceStarts,
  failStartBindingPreparation,
  getResourceStartRequest,
  getStartReceipt,
  listStartReceipts,
  listPendingStartBindings,
  listQueuedResourceStartsForHost,
  resetStartBindingPreparation,
  withdrawQueuedResourceStart,
  type ResourceStartRequestInspection,
} from '@archon/core/db/resource-starts';
import { getUserById } from '@archon/core/db/users';
import { loadWorkflowRunConfigFile } from '@archon/core/config';
import { resourceStartBindingIntentSchema } from '@archon/workflows/schemas/resource-start';
import { readWorkflowSourceState } from '@archon/workflows/schemas/workflow-run';
import { executePreparedWorkflowLaunch, withPreparedWorkflowLaunch } from '../workflow-launch';
import { writeJsonLine } from '../utils/stdout';
import { DETACHED_RUN_OWNER_ENV } from '../utils/detached-run-control';
import { installMacosNativeSchedule, removeMacosNativeSchedule } from '../triggers/native-schedule';

export const timerTriggerConfigSchema = z
  .object({
    version: z.literal(1),
    sourceInstanceId: z.string().min(1),
    binding: resourceStartBindingIntentSchema,
    schedule: z
      .object({ intervalSeconds: z.number().int().positive(), runAtLoad: z.boolean() })
      .strict(),
  })
  .strict();

async function loadTimerConfig(
  path: string,
  validateRunAs = true
): Promise<z.infer<typeof timerTriggerConfigSchema>> {
  const value = timerTriggerConfigSchema.safeParse(
    JSON.parse(await readFile(path, 'utf8')) as unknown
  );
  if (!value.success)
    throw new Error(
      `Invalid timer configuration fields: ${value.error.issues.map(issue => issue.path.join('.')).join(', ')}`
    );
  if (!isAbsolute(value.data.binding.launch.cwd))
    throw new Error('Trigger execution cwd must be absolute.');
  if (validateRunAs && !(await getUserById(value.data.binding.runAsUserId)))
    throw new Error('Trigger binding names an unknown run-as user.');
  return value.data;
}

function cliPrefix(): [string, ...string[]] {
  return BUNDLED_IS_BINARY ? [process.execPath] : [process.execPath, resolve(process.argv[1])];
}

async function spawnRequest(request: ResourceStartRequestInspection): Promise<void> {
  const [executable, ...prefix] = cliPrefix();
  const logDirectory = join(getArchonHome(), 'logs');
  await mkdir(logDirectory, { recursive: true });
  const log = await open(join(logDirectory, `trigger-run-${request.id}.log`), 'a', 0o600);
  try {
    const child = spawn(
      executable,
      [...prefix, 'trigger', 'execute', request.id, '--host', request.hostId],
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

async function launchAdmitted(requestId: string): Promise<void> {
  const request = await getResourceStartRequest(requestId);
  if (request?.status !== 'admitted') throw new Error('The admitted start request is unavailable.');
  await spawnRequest(request);
}

export async function drainTriggerHost(hostId: string): Promise<void> {
  const failures: unknown[] = [];
  const pending = await listPendingStartBindings({ hostId });
  for (const binding of pending) {
    if (!binding.intent) continue;
    const ownerId = randomUUID();
    const identity = { receiptId: binding.receiptId, bindingId: binding.bindingId, ownerId };
    if (!(await claimStartBindingPreparation(identity))) continue;
    const intent = binding.intent;
    let stage: 'run_as_user' | 'run_configuration' | 'launch_preparation' | 'dispatch' =
      'run_as_user';
    try {
      if (!(await getUserById(intent.runAsUserId)))
        throw new Error('The configured run-as user no longer exists.');
      stage = 'run_configuration';
      const runConfig = intent.launch.configSource
        ? await loadWorkflowRunConfigFile(intent.launch.configSource)
        : undefined;
      stage = 'launch_preparation';
      const disposition = await withPreparedWorkflowLaunch(
        {
          ...intent.launch,
          actingUserId: intent.runAsUserId,
          userMessage: `Triggered by binding ${intent.bindingId}`,
          runConfig,
        },
        async ({ launch, adoptSource }) => {
          const result = await completeStartBindingPreparation({ ...identity, launch });
          if (!result) throw new Error('Preparation ownership changed before durable acceptance.');
          if (result.status !== 'skipped') adoptSource();
          return result;
        }
      );
      stage = 'dispatch';
      if (disposition.status === 'admitted') await launchAdmitted(disposition.requestId);
    } catch (error) {
      // Unknown preparation failures are not an implicit retry policy. The receipt remains inspectable.
      // Configuration and provider errors can contain secret values. Persist the failed
      // boundary, not arbitrary exception text; the original cause reaches the caller.
      if (stage !== 'dispatch')
        await failStartBindingPreparation({
          ...identity,
          retryable: false,
          error: `${stage}_failed`,
        });
      failures.push(error);
    }
  }
  const queued = await listQueuedResourceStartsForHost(hostId);
  for (const resource of new Set(queued.map(request => request.resource))) {
    for (const decision of await drainResourceStarts({ hostId, resource })) {
      if (decision.status === 'admitted') await launchAdmitted(decision.requestId);
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      `${String(failures.length)} trigger preparation(s) failed; inspect their receipt records.`
    );
}

export async function triggerCommand(
  action: string | undefined,
  args: string[],
  options: { config?: string; host?: string; owner?: string; yes?: boolean; limit?: string }
): Promise<void> {
  if (action === 'list') {
    await writeJsonLine(
      await listStartReceipts(options.limit === undefined ? undefined : Number(options.limit))
    );
    return;
  }
  if (action === 'fire') {
    if (!options.config)
      throw new Error('Usage: archon trigger fire --config <timer-binding.json>');
    const config = await loadTimerConfig(options.config);
    const binding = {
      ...config.binding,
      bindingRevision: createHash('sha256').update(JSON.stringify(config.binding)).digest('hex'),
    };
    const receipt = await acceptStartReceipt({
      receipt: {
        id: randomUUID(),
        sourceInstanceId: config.sourceInstanceId,
        deliveryId: null,
        contentDigest: createHash('sha256').update(JSON.stringify(config)).digest('hex'),
        receivedAt: new Date().toISOString(),
        occurredAt: null,
        sourceActor: null,
      },
      outcome: 'matched',
      bindings: [binding],
    });
    try {
      await drainTriggerHost(binding.hostId);
    } catch (error) {
      throw new Error(
        `Receipt ${receipt.receiptId} is retained, but its host drain failed. Inspect that receipt before recovery.`,
        { cause: error }
      );
    }
    await writeJsonLine(await getStartReceipt(receipt.receiptId));
    return;
  }
  if (action === 'drain') {
    if (!options.host) throw new Error('Usage: archon trigger drain --host <configured-host>');
    await drainTriggerHost(options.host);
    await writeJsonLine({ hostId: options.host, drained: true });
    return;
  }
  if (action === 'execute') {
    const request = args[0] ? await getResourceStartRequest(args[0]) : null;
    if (request?.status !== 'admitted' || request.hostId !== options.host)
      throw new Error('Execution requires an admitted request for this configured host.');
    await executePreparedWorkflowLaunch(request.launch);
    return;
  }
  if (action === 'inspect') {
    if (!args[0]) throw new Error('Usage: archon trigger inspect <receipt-or-request-id>');
    const value = (await getStartReceipt(args[0])) ?? (await getResourceStartRequest(args[0]));
    if (!value) throw new Error('Trigger receipt or request not found.');
    if ('launch' in value) {
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
                    }
                  : {}),
                prerequisite:
                  'Verify the exact execution owner and its descendants have stopped. Age or an unreachable endpoint is not proof.',
                abandonCommand: `archon workflow abandon ${runId}`,
              },
            }
          : null,
      });
    } else await writeJsonLine(value);
    return;
  }
  if (action === 'recover-preparation') {
    if (!args[0] || !args[1] || !options.owner || !options.yes)
      throw new Error(
        'After confirming the exact preparation owner is stopped: archon trigger recover-preparation <receipt-id> <binding-id> --owner <recorded-owner-id> --yes'
      );
    const reset = await resetStartBindingPreparation({
      receiptId: args[0],
      bindingId: args[1],
      ownerId: options.owner,
    });
    if (!reset)
      throw new Error('Preparation ownership no longer matches; inspect the receipt again.');
    await writeJsonLine({ recovered: true });
    return;
  }
  if (action === 'withdraw') {
    if (!args[0]) throw new Error('Usage: archon trigger withdraw <queued-request-id>');
    const request = await getResourceStartRequest(args[0]);
    if (!request || !(await withdrawQueuedResourceStart(args[0])))
      throw new Error('Only untouched queued requests can be withdrawn.');
    const source = readWorkflowSourceState(request.launch.run.metadata);
    if (source.kind === 'recorded') await rm(source.record.root, { recursive: true, force: true });
    if (source.kind === 'unreadable')
      throw new Error(
        'Request withdrawn, but its source record is unreadable; inspect storage before cleanup.'
      );
    await writeJsonLine({ requestId: args[0], withdrawn: true });
    return;
  }
  if (action === 'schedule') {
    if (!options.config || !['install', 'remove'].includes(args[0] ?? ''))
      throw new Error(
        'Usage: archon trigger schedule <install|remove> --config <timer-binding.json>'
      );
    const config = await loadTimerConfig(options.config, args[0] !== 'remove');
    const scheduleId = createHash('sha256')
      .update(JSON.stringify([getArchonHome(), config.sourceInstanceId, config.binding.bindingId]))
      .digest('hex');
    if (args[0] === 'remove') await removeMacosNativeSchedule(scheduleId);
    else {
      const [executable, ...prefix] = cliPrefix();
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
    return;
  }
  throw new Error(
    'Usage: archon trigger <fire|drain|list|inspect|withdraw|recover-preparation|schedule>'
  );
}
