/**
 * `archon hold set|lift`: hold all new work on the install, and lift the hold. While it is
 * set, admission admits no new run from any source; runs already running or paused go on.
 * Lifting starts what was held on each host that has it, as `trigger drain` would.
 */
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { describeInstallHold } from '@archon/workflows/schemas/resource-start';
import { writeJsonLine } from '../utils/stdout';
import { resolveCliUserId } from './auth';
import { drainFailureReasons, drainHost, type TriggerDispatch } from './trigger';

async function setHold(host: WorkflowHost, json: boolean): Promise<number> {
  const cliId = resolveCliUserId();
  if (!cliId)
    throw new Error('Could not determine your CLI identity. Set ARCHON_USER_ID or $USER.');
  const { hold, alreadySet } = await host.deps.store.setInstallHold({ setBy: cliId });
  if (json) {
    await writeJsonLine({ hold, alreadySet });
    return 0;
  }
  console.log(
    alreadySet
      ? `New runs were already held on this install (${describeInstallHold(hold)}).`
      : `New runs are held on this install (${describeInstallHold(hold)}). Running runs continue. Lift with: archon hold lift`
  );
  return 0;
}

async function liftHold(
  host: WorkflowHost,
  json: boolean,
  dispatch: TriggerDispatch
): Promise<number> {
  const lifted = await host.deps.store.liftInstallHold();
  // Read after the lift, so a start held until the last moment is not left for a later pass.
  const hostIds = lifted
    ? [
        ...new Set(
          (await host.deps.store.listHeldStarts()).flatMap(start =>
            start.hostId === null ? [] : [start.hostId]
          )
        ),
      ]
    : [];
  const failures: { hostId: string; error: string }[] = [];
  for (const hostId of hostIds) {
    try {
      await drainHost(host, hostId, dispatch);
    } catch (error) {
      failures.push({ hostId, error: drainFailureReasons([error]) });
    }
  }
  if (json) await writeJsonLine({ lifted, drainedHosts: hostIds, failures });
  else if (!lifted) console.log('No install hold was set.');
  else
    console.log(
      `Lifted the install hold (${describeInstallHold(lifted)}). ${
        hostIds.length === 0
          ? 'No trigger start was held.'
          : `Started the held work on host(s) ${hostIds.join(', ')}.`
      } Waiting hand starts start on their own.`
    );
  for (const failure of failures)
    process.stderr.write(
      `The hold is lifted, but draining host ${failure.hostId} failed: ${failure.error}. Retry with: archon trigger drain --host ${failure.hostId}\n`
    );
  return failures.length === 0 ? 0 : 1;
}

export async function holdCommand(
  host: WorkflowHost,
  action: string | undefined,
  options: { json: boolean },
  dispatch: TriggerDispatch
): Promise<number> {
  switch (action) {
    case 'set':
      return setHold(host, options.json);
    case 'lift':
      return liftHold(host, options.json, dispatch);
    default:
      throw new Error('Usage: archon hold <set|lift>');
  }
}
