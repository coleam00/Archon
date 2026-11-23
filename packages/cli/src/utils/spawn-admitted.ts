import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getArchonHome } from '@archon/paths';
import { RUN_GITHUB_IDENTITY_HANDOFF_ENV } from '@archon/paths/github-token-env';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { HandOffUncertainError, type StartedExecutor } from '@archon/core/workflows/start-executor';
import { resolveUserGithubIdentityEnv } from '@archon/workflows/run-credential-env';
import { cliProgramArguments } from './cli-program-arguments';
import { DETACHED_RUN_OWNER_ENV } from './detached-run-control';
import { startTriggerExecutor, TriggerExecutorRelayError } from './run-job-escape';

/**
 * Hand one admitted request to a detached `trigger execute` process with its own log, and
 * name that process when it started here. Through a Windows run's broker the pid is not
 * reported, so it resolves null and nothing is recorded. A plain rejection means nothing
 * started (`handOffAdmitted` records it as a failed hand-off); a broker relay that failed
 * part way leaves that open and rejects with `HandOffUncertainError`.
 *
 * The executor carries the run's user's GitHub identity, so the git Archon runs for the
 * run before its first node (landing check, worktree fetch, submodules) authenticates as
 * that user, never as whoever spawned it: a node whose own run is scrubbed can hand off a
 * start for a connected user. The handoff marker keeps Archon's env files from replacing
 * that identity when the executor loads them.
 *
 * The token rides GH_TOKEN alone, which gh and the run's git helper read. In the
 * executor's own env, GITHUB_TOKEN is install configuration: next to App credentials it
 * reads as PAT mode and the executor refuses to start. So it is emptied, which also keeps
 * a spawner's own token from reaching the run. Nodes set both keys for themselves.
 */
export async function spawnAdmitted(
  host: {
    readonly deps: {
      readonly store: Pick<WorkflowHost['deps']['store'], 'getResourceStartRequest'>;
    } & Partial<Pick<WorkflowHost['deps'], 'isPerUserGitHubEnabled' | 'getUserGithubToken'>>;
  },
  requestId: string,
  hostId: string
): Promise<StartedExecutor | null> {
  const request = await host.deps.store.getResourceStartRequest(requestId);
  if (request?.status !== 'admitted') throw new Error('The admitted start request is unavailable.');
  const identity = await resolveUserGithubIdentityEnv(host.deps, request.launch.run.origin?.userId);
  const identityHandoff =
    Object.keys(identity).length > 0
      ? { ...identity, GITHUB_TOKEN: '', [RUN_GITHUB_IDENTITY_HANDOFF_ENV]: '1' }
      : {};
  const logDirectory = join(getArchonHome(), 'logs');
  await mkdir(logDirectory, { recursive: true });
  let pid: number | undefined;
  try {
    // Inside a Windows run this starts through the run's job broker: the executor is another
    // run's owner and must not end with the run that started it.
    pid = await startTriggerExecutor(
      {
        args: ['trigger', 'execute', requestId, '--host', hostId],
        cwd: request.launch.execution.cwd,
        env: {
          ...process.env,
          ...identityHandoff,
          ARCHON_HOME: getArchonHome(),
          [DETACHED_RUN_OWNER_ENV]: '1',
        },
        log: join(logDirectory, `trigger-run-${requestId}.log`),
      },
      cliProgramArguments()
    );
  } catch (error) {
    if (error instanceof TriggerExecutorRelayError)
      throw new HandOffUncertainError(error.message, { cause: error });
    throw error;
  }
  return pid === undefined ? null : { pid };
}
