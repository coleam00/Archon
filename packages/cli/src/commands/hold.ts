/**
 * `archon hold set|lift`: hold all new work on the install, and lift the hold. While it is
 * set, admission admits no new run from any source; runs already running or paused go on.
 * Lifting drains each host this install's trigger files name, as `trigger drain` would; a
 * host named only by work in the store is another machine's and is left to its own drain.
 */
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { describeInstallHold } from '@archon/workflows/schemas/resource-start';
import { writeJsonLine } from '../utils/stdout';
import { resolveCliUserId } from './auth';
import { drainFailureReasons, drainInstallHosts } from '../utils/install-hosts';
import { cliOwnTriggerHost } from '../utils/workflow-host';
import type { TriggerDispatch } from './trigger';

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
  // Drained after the lift, so a start held until the last moment is not left for a later pass.
  const drained = lifted
    ? await drainInstallHosts(host, { ownHost: cliOwnTriggerHost(), dispatch })
    : { hostIds: [], failures: [] };
  const hostIds = drained.hostIds;
  const failures = drained.failures.map(failure => ({
    ...(failure.hostId === undefined ? {} : { hostId: failure.hostId }),
    error: drainFailureReasons([failure.error]),
  }));
  // Read for the message only: a host named by no trigger file here is another machine's,
  // and its own drain starts what it holds.
  const elsewhere = lifted
    ? [
        ...new Set(
          (await host.deps.store.listHeldStarts()).flatMap(start =>
            start.hostId === null || hostIds.includes(start.hostId) ? [] : [start.hostId]
          )
        ),
      ]
    : [];
  if (json) await writeJsonLine({ lifted, drainedHosts: hostIds, failures, elsewhere });
  else if (!lifted) console.log('No install hold was set.');
  else
    console.log(
      `Lifted the install hold (${describeInstallHold(lifted)}). ${
        hostIds.length === 0
          ? 'No trigger file on this install names a host to drain.'
          : `Drained host(s) ${hostIds.join(', ')}.`
      }${
        elsewhere.length === 0
          ? ''
          : ` Work waits on host(s) ${elsewhere.join(', ')}, which no trigger file here names; each host's own drain starts it (archon trigger drain --host <host> where it runs).`
      } Waiting hand starts start on their own.`
    );
  for (const failure of failures)
    process.stderr.write(
      failure.hostId === undefined
        ? `The hold is lifted, but a trigger file did not read: ${failure.error}. Fix it, then run archon trigger drain --host <host> for the host it names.\n`
        : `The hold is lifted, but draining host ${failure.hostId} failed: ${failure.error}. Retry with: archon trigger drain --host ${failure.hostId}\n`
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
