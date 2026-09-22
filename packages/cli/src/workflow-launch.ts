import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { loadConfig } from '@archon/core';
import { sealWorkflowRunConfig } from '@archon/core/config';
import * as conversationDb from '@archon/core/db/conversations';
import { createWorkflowDeps } from '@archon/core/workflows/store-adapter';
import {
  finalizeWorkflowSource,
  prepareWorkflowSource,
  preparedWorkflowSourceRecord,
  recordSelectedWorkflow,
  withCapturedSource,
} from '@archon/workflows/executor';
import type { JsonValue } from '@archon/workflows/output-ref';
import { resolveWorkflowName } from '@archon/workflows/router';
import { WORKFLOW_RUN_CONFIG_METADATA_KEY } from '@archon/workflows/run-config';
import type { WorkflowRunConfigInput } from '@archon/workflows/schemas/run-config';
import {
  SUBRUN_METADATA_KEYS,
  WORKFLOW_SOURCE_METADATA_KEY,
} from '@archon/workflows/schemas/workflow-run';
import {
  preparedWorkflowLaunchSchema,
  type PreparedWorkflowLaunch,
} from '@archon/workflows/schemas/resource-start';
import {
  assertComposedGateDriveable,
  assertInteractiveClassNotBackgrounded,
} from '@archon/workflows/utils/workflow-requirements';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import {
  resolveDeclaredInputs,
  WorkflowInputContractError,
} from '@archon/workflows/workflow-inputs';
import {
  assertWorkflowRequirementsForUser,
  resolveRunCodebase,
  workflowRunCommand,
} from './commands/workflow';

export interface PrepareWorkflowLaunchInput {
  cwd: string;
  discoveryCwd?: string;
  workflowName: string;
  userMessage: string;
  actingUserId: string;
  conversationId?: string;
  inputs?: Readonly<Record<string, JsonValue>>;
  runConfig?: WorkflowRunConfigInput;
  isolation?:
    | { kind: 'default' }
    | { kind: 'in-place' }
    | { kind: 'worktree'; branch?: string; fromBranch?: string; baseOverride?: string };
}

/**
 * Prepare a durable fresh launch while one cleanup owner covers the source capture.
 * The consumer must durably accept the launch before calling `adoptSource`.
 */
export async function withPreparedWorkflowLaunch<T>(
  input: PrepareWorkflowLaunchInput,
  consume: (prepared: { launch: PreparedWorkflowLaunch; adoptSource: () => void }) => Promise<T>
): Promise<T> {
  if (!input.actingUserId.trim())
    throw new Error('A durable workflow launch requires an acting user.');
  const cwd = resolve(input.cwd);
  const sourceRoot = resolve(input.discoveryCwd ?? cwd);

  return await withCapturedSource(async owner => {
    let source = await prepareWorkflowSource(createWorkflowDeps(), { sourceRoot });
    owner.hold(source);

    const discovered = await discoverWorkflowsWithConfig(cwd, loadConfig, source.roots);
    const workflow = resolveWorkflowName(
      input.workflowName,
      discovered.workflows.map(entry => entry.workflow)
    );
    if (!workflow) {
      const loadError = discovered.errors.find(
        error => error.filename.replace(/\.ya?ml$/, '') === input.workflowName
      );
      if (loadError) {
        throw new Error(`Workflow '${input.workflowName}' failed to load: ${loadError.error}`);
      }
      throw new Error(`Workflow '${input.workflowName}' not found.`);
    }
    await recordSelectedWorkflow(source.anchor.root, workflow.name);

    assertInteractiveClassNotBackgrounded(workflow);
    assertComposedGateDriveable(workflow.nodes);
    await assertWorkflowRequirementsForUser(workflow, input.actingUserId);
    const suppliedInputs = { ...input.inputs };
    let resolvedInputs: Record<string, JsonValue>;
    try {
      resolveDeclaredInputs(
        suppliedInputs,
        workflow.inputs,
        `Cannot run workflow '${workflow.name}'`,
        'it'
      );
      // Persist only authored values. Defaults remain derived from the frozen workflow.
      resolvedInputs = suppliedInputs;
    } catch (error) {
      if (error instanceof WorkflowInputContractError && error.missingRequired.length > 0) {
        throw new Error(
          `Workflow '${workflow.name}' requires input${error.missingRequired.length === 1 ? '' : 's'} ` +
            error.missingRequired.map(name => `'${name}'`).join(', ') +
            '.'
        );
      }
      throw error;
    }

    const codebase = (await resolveRunCodebase(cwd, { folder: false })).codebase;
    if (!codebase) {
      throw new Error(
        `Cannot prepare durable workflow launch from '${cwd}': register the project first.`
      );
    }

    const requestedIsolation = input.isolation ?? { kind: 'default' as const };
    const pinned = workflow.worktree?.enabled;
    if (requestedIsolation.kind === 'in-place' && pinned === true) {
      throw new Error(`Workflow '${workflow.name}' requires worktree isolation.`);
    }
    if (requestedIsolation.kind === 'worktree' && pinned === false) {
      throw new Error(`Workflow '${workflow.name}' requires in-place execution.`);
    }
    if (codebase.kind === 'folder' && pinned === true) {
      throw new Error(
        `Workflow '${workflow.name}' requires worktree isolation, which folder projects do not support.`
      );
    }
    const wantsWorktree =
      requestedIsolation.kind === 'worktree' ||
      (requestedIsolation.kind === 'default' && codebase.kind !== 'folder' && pinned !== false);
    if (codebase.kind === 'folder' && wantsWorktree) {
      throw new Error(`Folder project '${codebase.name}' does not support worktree isolation.`);
    }
    const isolation = wantsWorktree
      ? {
          kind: 'worktree' as const,
          ...(requestedIsolation.kind === 'worktree' ? requestedIsolation : {}),
        }
      : { kind: 'in-place' as const };

    source = await finalizeWorkflowSource(createWorkflowDeps(), source, {
      cwd,
      codebaseId: codebase.id,
    });
    owner.hold(source);
    const conversationId = input.conversationId ?? `trigger-${randomUUID()}`;
    const conversation = await conversationDb.getOrCreateConversation('cli', conversationId);
    const metadata: Record<string, JsonValue> = {
      [WORKFLOW_SOURCE_METADATA_KEY]: preparedWorkflowSourceRecord(source),
      ...(Object.keys(resolvedInputs).length > 0
        ? { [SUBRUN_METADATA_KEYS.inputsValues]: { ...resolvedInputs } }
        : {}),
      ...(input.runConfig
        ? {
            [WORKFLOW_RUN_CONFIG_METADATA_KEY]: sealWorkflowRunConfig(
              input.runConfig.layer,
              input.runConfig.source
            ),
          }
        : {}),
    };

    const launch: PreparedWorkflowLaunch = {
      version: 1,
      run: {
        id: source.runId,
        workflow_name: workflow.name,
        conversation_id: conversation.id,
        codebase_id: codebase.id,
        user_message: input.userMessage,
        metadata,
        working_path: isolation.kind === 'in-place' ? cwd : undefined,
        user_id: input.actingUserId,
      },
      execution: {
        cwd,
        conversationId,
        conversationDbId: conversation.id,
        actingUserId: input.actingUserId,
        inputs: resolvedInputs,
        isolation,
      },
    };
    return await consume({ launch, adoptSource: owner.adopt });
  });
}

/** Execute an admitted pending launch through the ordinary CLI host and engine. */
export async function executePreparedWorkflowLaunch(
  durableLaunch: PreparedWorkflowLaunch
): Promise<void> {
  const launch = preparedWorkflowLaunchSchema.parse(durableLaunch);
  const lane = launch.execution.isolation;
  await workflowRunCommand(
    launch.execution.cwd,
    launch.run.workflow_name,
    launch.run.user_message,
    {
      preparedLaunch: launch,
      conversationId: launch.execution.conversationId,
      codebaseId: launch.run.codebase_id,
      ...(lane.kind === 'in-place'
        ? { noWorktree: true }
        : {
            branchName: lane.branch,
            fromBranch: lane.fromBranch,
            baseBranch: lane.baseOverride,
          }),
    }
  );
}
