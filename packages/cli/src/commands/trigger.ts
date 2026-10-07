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
  startAdmittedResourceStart,
} from '@archon/core/workflows/resource-start-host';
import { resourceStartBindingIntentSchema } from '@archon/workflows/schemas/resource-start';
import { readWorkflowSourceState } from '@archon/workflows/schemas/workflow-run';
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
    binding: resourceStartBindingIntentSchema,
    schedule: z
      .object({ intervalSeconds: z.number().int().positive(), runAtLoad: z.boolean() })
      .strict(),
  })
  .strict();

async function loadTimerConfig(
  host: WorkflowHost,
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
  if (validateRunAs && !(await host.records.users.getUserById(value.data.binding.runAsUserId)))
    throw new Error('Trigger binding names an unknown run-as user.');
  return value.data;
}

/** Hand one admitted request to a detached `trigger execute` process with its own log. */
async function spawnAdmitted(host: WorkflowHost, requestId: string, hostId: string): Promise<void> {
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

function drainHost(host: WorkflowHost, hostId: string): Promise<void> {
  return drainResourceStartHost({
    ...host,
    hostId,
    startAdmitted: requestId => spawnAdmitted(host, requestId, hostId),
  });
}

export async function triggerCommand(
  host: WorkflowHost,
  action: string | undefined,
  args: string[],
  options: { config?: string; host?: string; owner?: string; yes?: boolean; limit?: string }
): Promise<void> {
  if (action === 'whoami') {
    const cliId = resolveCliUserId();
    if (!cliId)
      throw new Error('Could not determine your CLI identity. Set ARCHON_USER_ID or $USER.');
    const user = await host.records.users.findOrCreateUserByPlatformIdentity('cli', cliId, cliId);
    await writeJsonLine({ runAsUserId: user.id, cliIdentity: cliId });
    return;
  }
  if (action === 'list') {
    await writeJsonLine(
      await host.deps.store.listStartReceipts(
        options.limit === undefined ? undefined : Number(options.limit)
      )
    );
    return;
  }
  if (action === 'fire') {
    if (!options.config)
      throw new Error('Usage: archon trigger fire --config <timer-binding.json>');
    const config = await loadTimerConfig(host, options.config);
    const binding = {
      ...config.binding,
      bindingRevision: createHash('sha256').update(JSON.stringify(config.binding)).digest('hex'),
    };
    const receipt = await host.deps.store.acceptStartReceipt({
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
      await drainHost(host, binding.hostId);
    } catch (error) {
      throw new Error(
        `Receipt ${receipt.receiptId} is retained, but its host drain failed. Inspect that receipt before recovery.`,
        { cause: error }
      );
    }
    await writeJsonLine(await host.deps.store.getStartReceipt(receipt.receiptId));
    return;
  }
  if (action === 'drain') {
    if (!options.host) throw new Error('Usage: archon trigger drain --host <configured-host>');
    await drainHost(host, options.host);
    await writeJsonLine({ hostId: options.host, drained: true });
    return;
  }
  if (action === 'execute') {
    if (!args[0] || !options.host)
      throw new Error(
        'Usage: archon trigger execute <admitted-request-id> --host <configured-host>'
      );
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
        registerOwnedRunTermination({ store: deps.store, ...owned, logModule: 'cli.trigger' }),
      ...(detachedProcessOwner ? { detachedProcessPid: process.pid } : {}),
    });
    if (!result.success) throw new Error(`Run ${args[0]} did not complete: ${result.error}`);
    return;
  }
  if (action === 'inspect') {
    if (!args[0]) throw new Error('Usage: archon trigger inspect <receipt-or-request-id>');
    const value =
      (await host.deps.store.getStartReceipt(args[0])) ??
      (await host.deps.store.getResourceStartRequest(args[0]));
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
    } else await writeJsonLine(value);
    return;
  }
  if (action === 'recover-preparation') {
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
    return;
  }
  if (action === 'withdraw') {
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
    return;
  }
  if (action === 'schedule') {
    if (!options.config || !['install', 'remove'].includes(args[0] ?? ''))
      throw new Error(
        'Usage: archon trigger schedule <install|remove> --config <timer-binding.json>'
      );
    const config = await loadTimerConfig(host, options.config, args[0] !== 'remove');
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
    return;
  }
  throw new Error(
    'Usage: archon trigger <fire|drain|execute|list|inspect|withdraw|recover-preparation|schedule|whoami>'
  );
}
