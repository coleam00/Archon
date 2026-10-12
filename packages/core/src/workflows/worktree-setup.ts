import { WORKFLOW_SOURCE_METADATA_KEY } from '@archon/workflows/schemas/workflow-run';
import { randomUUID } from 'node:crypto';
import {
  configureIsolation,
  WorktreePostCreateError,
  type WorktreeSetupExecutor,
} from '@archon/isolation';
import { resolveBashPath } from '@archon/git';
import { createLogger } from '@archon/paths';
import {
  collectCredentialValues,
  redactCredentialValues,
} from '@archon/paths/credential-redaction';
import {
  runSubprocess,
  isSubprocessTimeout,
  redactSubprocessError,
  retainStreamTail,
} from '@archon/workflows/subprocess';
import { logWorktreeSetup } from '@archon/workflows/logger';
import type {
  CapturedSourceOwner,
  PreparedWorkflowSource,
  resolveWorkflowGithubEnvironment,
} from '@archon/workflows/executor';
import type { WorkflowEnvironment, WorkflowDeps } from '@archon/workflows/deps';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { WorktreeSetupEvent } from '@archon/workflows/schemas/worktree-setup';
import { loadConfig, loadRepoConfig } from '../config/config-loader';
import { getCodebaseEnvVars } from '../db/env-vars';

export type WorktreeSetupDeps = Parameters<typeof resolveWorkflowGithubEnvironment>[0] & {
  store: Pick<WorkflowDeps['store'], 'getCodebase' | 'persistWorkflowEvent'>;
};

function createSetupExecutor(
  environment: WorkflowEnvironment,
  audit: (event: WorktreeSetupEvent) => Promise<void>,
  retention: { standalone: true } | { logDir: string; workflowRunId: string; label: string },
  attribution?: { parentNodeId: string; childIndex: number }
): WorktreeSetupExecutor {
  return async input => {
    const attemptId = randomUUID();
    const credentials = collectCredentialValues(
      { ...process.env, ...environment.envVars },
      environment.protectedEnvKeys,
      environment.protectedCredentialValues
    );
    const emit = async (event: WorktreeSetupEvent): Promise<void> => {
      try {
        await audit(event);
      } catch (error) {
        throw redactSubprocessError(
          error instanceof Error ? error : new Error(String(error)),
          credentials
        );
      }
    };
    for (const [commandIndex, command] of input.commands.entries()) {
      const safeCommand = redactCredentialValues(command, credentials);
      const identity = {
        attemptId,
        commandIndex,
        command: safeCommand,
        workingPath: input.workingPath,
        ...attribution,
      };
      const started = Date.now();
      await emit({
        ...identity,
        type: 'worktree_setup_started',
        message: `Worktree setup ${commandIndex + 1} started: ${safeCommand}`,
      });
      let result: Awaited<ReturnType<typeof runSubprocess>>;
      try {
        result = await runSubprocess({ kind: 'host' }, resolveBashPath(), ['-c', command], {
          cwd: input.workingPath,
          timeout: input.timeout,
          env: environment.envVars ?? {},
          protectedEnvKeys: environment.protectedEnvKeys,
          protectedCredentialValues: environment.protectedCredentialValues,
          retention:
            'standalone' in retention
              ? retention
              : { ...retention, nodeId: `setup-${attemptId}-${commandIndex}` },
        });
      } catch (error) {
        const rejection = redactSubprocessError(
          error instanceof Error ? error : new Error(String(error)),
          credentials
        );
        const failureKind = isSubprocessTimeout(rejection)
          ? 'timeout'
          : rejection.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
            ? 'output_limit'
            : typeof rejection.code === 'number' || rejection.signal
              ? 'exit'
              : 'spawn';
        const exitCode = typeof rejection.code === 'number' ? rejection.code : undefined;
        const errno = typeof rejection.code === 'string' ? rejection.code : undefined;
        const signal = rejection.signal ?? undefined;
        const detail =
          failureKind === 'timeout'
            ? `timed out after ${input.timeout} ms`
            : failureKind === 'exit'
              ? exitCode !== undefined
                ? `failed with exit code ${exitCode}`
                : `terminated by signal ${signal}`
              : `failed (${failureKind}): ${rejection.message}`;
        const failure = new WorktreePostCreateError(
          commandIndex,
          safeCommand,
          failureKind,
          `${detail}\n${retainStreamTail(rejection.stderr) ?? ''}\n${retainStreamTail(rejection.stdout) ?? ''}`,
          exitCode,
          errno,
          signal,
          rejection
        );
        try {
          await emit({
            ...identity,
            type: 'worktree_setup_failed',
            durationMs: Date.now() - started,
            failureKind,
            exitCode,
            errno,
            signal,
            stdoutTail: retainStreamTail(rejection.stdout),
            stderrTail: retainStreamTail(rejection.stderr),
            message: failure.message,
          });
        } catch (auditError) {
          const safeAuditError = redactSubprocessError(
            auditError instanceof Error ? auditError : new Error(String(auditError)),
            credentials
          );
          failure.message += `; could not persist setup failure: ${safeAuditError.message}`;
          failure.cause = new AggregateError([rejection, safeAuditError], failure.message);
          throw failure;
        }
        throw failure;
      }
      await emit({
        ...identity,
        type: 'worktree_setup_completed',
        durationMs: Date.now() - started,
        stdoutTail: retainStreamTail(redactCredentialValues(result.stdout, credentials)),
        stderrTail: retainStreamTail(result.stderr),
        message: `Worktree setup ${commandIndex + 1} completed: ${safeCommand}`,
      });
    }
  };
}

export function createRunWorktreeSetupExecutor(
  deps: WorktreeSetupDeps,
  run: Pick<WorkflowRun, 'id' | 'user_id'>,
  environment: WorkflowEnvironment,
  attribution?: { parentNodeId: string; childIndex: number }
): WorktreeSetupExecutor {
  return async input => {
    const { resolveProjectPaths, resolveWorkflowGithubEnvironment } =
      await import('@archon/workflows/executor');
    const effectiveEnvironment = await resolveWorkflowGithubEnvironment(
      deps,
      input.codebaseId,
      run.user_id ?? undefined,
      environment
    );
    const { logDir } = await resolveProjectPaths(
      deps,
      input.canonicalRepoPath,
      run.id,
      input.codebaseId
    );
    await createSetupExecutor(
      effectiveEnvironment,
      async event => {
        await deps.store.persistWorkflowEvent({
          workflow_run_id: run.id,
          event_type: event.type,
          data: event,
        });
        await logWorktreeSetup(logDir, run.id, event);
      },
      { logDir, workflowRunId: run.id, label: '<worktree.postCreate>' },
      attribution
    )(input);
  };
}

export const executeStandaloneWorktreeSetup: WorktreeSetupExecutor = async input => {
  const config = await loadConfig(input.canonicalRepoPath);
  const managed = await getCodebaseEnvVars(input.codebaseId);
  const log = createLogger('isolation.worktree-setup');
  await createSetupExecutor(
    {
      envVars: { ...config.envVars, ...managed },
      protectedCredentialValues: Object.values(managed),
    },
    async event => {
      if (event.type === 'worktree_setup_failed') log.error(event, event.type);
      else log.info(event, event.type);
    },
    { standalone: true }
  )(input);
};

export function configureWorktreeIsolation(): void {
  configureIsolation(
    async repoPath => (await loadRepoConfig(repoPath)).worktree ?? null,
    executeStandaloneWorktreeSetup
  );
}

export async function retainSetupRunSource(
  deps: WorkflowDeps,
  run: WorkflowRun,
  source: PreparedWorkflowSource,
  owner: CapturedSourceOwner,
  cwd: string,
  codebaseId?: string
): Promise<PreparedWorkflowSource> {
  const { finalizeWorkflowSource, preparedWorkflowSourceRecord } =
    await import('@archon/workflows/executor');
  const finalized = await finalizeWorkflowSource(deps, source, { cwd, codebaseId });
  owner.hold(finalized);
  const record = preparedWorkflowSourceRecord(finalized);
  await deps.store.updateWorkflowRun(run.id, {
    metadata: { [WORKFLOW_SOURCE_METADATA_KEY]: record },
  });
  run.metadata = { ...run.metadata, [WORKFLOW_SOURCE_METADATA_KEY]: record };
  owner.adopt();
  return finalized;
}
