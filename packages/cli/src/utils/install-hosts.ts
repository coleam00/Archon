/**
 * Which trigger hosts a CLI process drains, in one place: the hosts this install's trigger
 * files name (`ARCHON_HOME/triggers`), plus the host the process is declared to serve. A
 * host known only from queued work in the store belongs to another machine and is left to
 * that machine's drain. A run end, each `workflow wake` pass and `hold lift` all drain
 * through here, so a policy on who may drain a host has one place to apply.
 */
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { drainResourceStartHost } from '@archon/core/workflows/resource-start-host';
import { getTriggersPath, readTriggerFileHosts } from '@archon/core/workflows/run-ended';
import type { StartedExecutor } from '@archon/core/workflows/start-executor';
import { sanitizeCredentials } from '@archon/core/utils/credential-sanitizer';
import {
  collectCredentialValues,
  redactCredentialValues,
} from '@archon/paths/credential-redaction';
import { cliOwnTriggerHost } from './workflow-host';

/** The hosts a drain from this process covers, and the trigger files that did not read. */
export async function installHosts(
  ownHost: string | undefined
): Promise<{ hostIds: string[]; failures: Error[] }> {
  const named = await readTriggerFileHosts(getTriggersPath());
  return {
    hostIds: [...new Set([...(ownHost === undefined ? [] : [ownHost]), ...named.hostIds])],
    failures: named.failures,
  };
}

/**
 * The hosts a drain from this process covers, for a reader that tells an operator what
 * admits a waiting start. A trigger file that does not read is reported by the drains.
 */
export async function servedHosts(): Promise<ReadonlySet<string>> {
  return new Set((await installHosts(cliOwnTriggerHost())).hostIds);
}

export interface InstallHostsDrain {
  hostIds: string[];
  /** One per host whose drain failed, and one per trigger file that did not read (no host). */
  failures: { hostId?: string; error: unknown }[];
}

/**
 * Drain every host `installHosts` names, one after another, handing each admitted start
 * to `dispatch`. Admission is the store's, so capacity is checked there and nowhere else.
 * One host's failure does not keep the others from draining; every failure is returned.
 */
export async function drainInstallHosts(
  host: WorkflowHost,
  options: {
    ownHost: string | undefined;
    dispatch: (requestId: string, hostId: string) => Promise<StartedExecutor | null>;
  }
): Promise<InstallHostsDrain> {
  const { hostIds, failures: fileFailures } = await installHosts(options.ownHost);
  const failures: InstallHostsDrain['failures'] = fileFailures.map(error => ({ error }));
  for (const hostId of hostIds) {
    try {
      await drainResourceStartHost({
        ...host,
        hostId,
        startAdmitted: requestId => options.dispatch(requestId, hostId),
      });
    } catch (error) {
      failures.push({ hostId, error });
    }
  }
  return { hostIds, failures };
}

/**
 * The messages behind drain failures, for the operator's terminal. The store keeps only
 * the failed stage because configuration and provider errors can carry credentials, so
 * the text is redacted with the same policy as subprocess output before it is shown.
 * Flattens the nested `AggregateError`s the drain builds, which carry no reason of their own.
 */
export function drainFailureReasons(errors: readonly unknown[]): string {
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
