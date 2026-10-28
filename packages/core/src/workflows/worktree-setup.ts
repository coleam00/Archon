import type { resolveWorkflowGithubEnvironment } from '@archon/workflows/run-credential-env';
import { WORKFLOW_SOURCE_METADATA_KEY } from '@archon/workflows/schemas/workflow-run';
import { randomUUID } from 'node:crypto';
import {
  configureIsolation,
  WorktreePostCreateError,
  type WorktreeSetupExecutor,
  type WorktreeSetupInput,
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
  type RawSubprocessRejection,
} from '@archon/workflows/subprocess';
import { logWorktreeSetup } from '@archon/workflows/logger';
import type { CapturedSourceOwner, PreparedWorkflowSource } from '@archon/workflows/run-source';
import type { WorkflowEnvironment, WorkflowDeps } from '@archon/workflows/deps';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { WorktreeSetupEvent } from '@archon/workflows/schemas/worktree-setup';
import { loadConfig, loadRepoConfig } from '../config/config-loader';
import { getCodebaseEnvVars } from '../db/env-vars';

export type WorktreeSetupDeps = Parameters<typeof resolveWorkflowGithubEnvironment>[0] & {
  store: Pick<WorkflowDeps['store'], 'getCodebase' | 'persistWorkflowEvent'>;
};

type SetupRetention =
  | { standalone: true }
  | { logDir: string; workflowRunId: string; label: string };
type SetupAttribution = { parentNodeId: string; childIndex: number };
type SetupFailureKind = WorktreePostCreateError['failureKind'];

/** What every command of one setup attempt shares. */
interface SetupAttempt {
  input: WorktreeSetupInput;
  environment: WorkflowEnvironment;
  retention: SetupRetention;
  credentials: string[];
  emit: (event: WorktreeSetupEvent) => Promise<void>;
}

/** The redacted fields every event of one setup command carries. */
interface SetupCommandIdentity {
  attemptId: string;
  commandIndex: number;
  command: string;
  workingPath: string;
  parentNodeId?: string;
  childIndex?: number;
}

function createSetupExecutor(
  environment: WorkflowEnvironment,
  audit: (event: WorktreeSetupEvent) => Promise<void>,
  retention: SetupRetention,
  attribution?: SetupAttribution
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
        throw redactError(error, credentials);
      }
    };
    const attempt: SetupAttempt = { input, environment, retention, credentials, emit };
    for (const [commandIndex, command] of input.commands.entries()) {
      const identity: SetupCommandIdentity = {
        attemptId,
        commandIndex,
        command: redactCredentialValues(command, credentials),
        workingPath: input.workingPath,
        ...attribution,
      };
      await runSetupCommand(attempt, identity, command);
    }
  };
}

async function runSetupCommand(
  { input, environment, retention, credentials, emit }: SetupAttempt,
  identity: SetupCommandIdentity,
  command: string
): Promise<void> {
  const { attemptId, commandIndex, command: safeCommand } = identity;
  await emit({
    ...identity,
    type: 'worktree_setup_started',
    message: `Worktree setup ${commandIndex + 1} started: ${safeCommand}`,
  });
  // After the audit write: the timeout checks below measure the command alone.
  const started = Date.now();
  let result: Awaited<ReturnType<typeof runSubprocess>>;
  try {
    result = await runSubprocess({ kind: 'host' }, resolveBashPath(), ['-c', command], {
      cwd: input.workingPath,
      timeout: input.timeout,
      ownProcessGroup: true,
      env: environment.envVars ?? {},
      protectedEnvKeys: environment.protectedEnvKeys,
      protectedCredentialValues: environment.protectedCredentialValues,
      retention:
        'standalone' in retention
          ? retention
          : { ...retention, nodeId: `setup-${attemptId}-${commandIndex}` },
    });
  } catch (error) {
    const rejection = redactError(error, credentials);
    throw await recordSetupFailure({ input, credentials, emit }, identity, rejection, started);
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

/**
 * Audit a failed setup command and return the error to throw. When the audit write
 * fails too, the error says so and keeps both causes.
 */
async function recordSetupFailure(
  { input, credentials, emit }: Pick<SetupAttempt, 'input' | 'credentials' | 'emit'>,
  identity: SetupCommandIdentity,
  rejection: RawSubprocessRejection,
  started: number
): Promise<WorktreePostCreateError> {
  const failureKind = setupFailureKind(rejection);
  const exitCode = typeof rejection.code === 'number' ? rejection.code : undefined;
  const errno = typeof rejection.code === 'string' ? rejection.code : undefined;
  const signal = rejection.signal ?? undefined;
  const detail = setupFailureDetail(failureKind, input.timeout, exitCode, signal, rejection);
  const failure = new WorktreePostCreateError(
    identity.commandIndex,
    identity.command,
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
    const safeAuditError = redactError(auditError, credentials);
    failure.message += `; could not persist setup failure: ${safeAuditError.message}`;
    failure.cause = new AggregateError([rejection, safeAuditError], failure.message);
  }
  return failure;
}

function setupFailureKind(rejection: RawSubprocessRejection): SetupFailureKind {
  if (isSubprocessTimeout(rejection)) return 'timeout';
  if (rejection.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'output_limit';
  if (typeof rejection.code === 'number' || rejection.signal) return 'exit';
  return 'spawn';
}

function setupFailureDetail(
  failureKind: SetupFailureKind,
  timeout: WorktreeSetupInput['timeout'],
  exitCode: number | undefined,
  signal: string | undefined,
  rejection: RawSubprocessRejection
): string {
  if (failureKind === 'timeout') return `timed out after ${timeout} ms`;
  if (failureKind !== 'exit') return `failed (${failureKind}): ${rejection.message}`;
  return exitCode !== undefined
    ? `failed with exit code ${exitCode}`
    : `terminated by signal ${signal}`;
}

function redactError(error: unknown, credentials: readonly string[]): RawSubprocessRejection {
  return redactSubprocessError(
    error instanceof Error ? error : new Error(String(error)),
    credentials
  );
}

export function createRunWorktreeSetupExecutor(
  deps: WorktreeSetupDeps,
  run: Pick<WorkflowRun, 'id' | 'user_id'>,
  environment: WorkflowEnvironment,
  attribution?: { parentNodeId: string; childIndex: number }
): WorktreeSetupExecutor {
  return async input => {
    const { resolveProjectPaths } = await import('@archon/workflows/run-paths');
    const { resolveWorkflowGithubEnvironment } = await import(
      '@archon/workflows/run-credential-env'
    );
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
  const { finalizeWorkflowSource } = await import('@archon/workflows/run-source');
  const finalized = await finalizeWorkflowSource(deps, source, { cwd, codebaseId });
  owner.hold(finalized);
  await recordSetupRunSource(deps, run, finalized);
  owner.adopt();
  return finalized;
}

/**
 * Write the source pointer onto a run created before its worktree. The executor keeps a
 * recorded source as-is, so a caller that changes the source origin after isolation (a
 * checkout-branch adoption) must record it again here.
 */
export async function recordSetupRunSource(
  deps: WorkflowDeps,
  run: WorkflowRun,
  source: PreparedWorkflowSource
): Promise<void> {
  const { preparedWorkflowSourceRecord } = await import('@archon/workflows/run-source');
  const record = preparedWorkflowSourceRecord(source);
  await deps.store.updateWorkflowRun(run.id, {
    metadata: { [WORKFLOW_SOURCE_METADATA_KEY]: record },
  });
  run.metadata = { ...run.metadata, [WORKFLOW_SOURCE_METADATA_KEY]: record };
}
