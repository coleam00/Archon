import type { IWorkflowStore } from '@archon/workflows/store';
import {
  CONTINUATION_MODES,
  TERMINAL_WORKFLOW_STATUSES,
  type ContinuationMetadata,
  type WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import { findProjectRunsByReference, isFullRunId } from '../workflows/run-id';

export class WorkflowContinuationError extends Error {}

export interface ResolvedRunContinuation {
  run: WorkflowRun;
  stamp: ContinuationMetadata;
}

type ContinuationStore = Pick<IWorkflowStore, 'getWorkflowRun' | 'findWorkflowRunsByIdPrefix'>;

export async function resolveRunContinuation({
  store,
  adoptRunId,
  supersedesRunId,
  codebaseId,
  restrictToProject = false,
}: {
  store: ContinuationStore;
  adoptRunId?: string;
  supersedesRunId?: string;
  codebaseId?: string | null;
  restrictToProject?: boolean;
}): Promise<ResolvedRunContinuation | undefined> {
  if (adoptRunId !== undefined && supersedesRunId !== undefined) {
    throw new WorkflowContinuationError(
      'adoptRunId and supersedesRunId are mutually exclusive. Choose adoption or supersede.'
    );
  }
  const reference = adoptRunId ?? supersedesRunId;
  if (reference === undefined) return undefined;
  const mode = adoptRunId !== undefined ? CONTINUATION_MODES.adopt : CONTINUATION_MODES.supersede;
  const run = await resolveRunReference(store, reference, codebaseId, restrictToProject);
  if (!run) {
    throw new WorkflowContinuationError(`Cannot ${mode}: no workflow run '${reference}' exists.`);
  }
  if (!TERMINAL_WORKFLOW_STATUSES.includes(run.status)) {
    throw new WorkflowContinuationError(
      `Cannot ${mode} run '${run.id}': it is still ${run.status}.` +
        (mode === CONTINUATION_MODES.adopt
          ? " Respond to or resume it, or abandon it first — adoption never takes a live run's lane."
          : '')
    );
  }
  return { run, stamp: { mode } };
}

async function resolveRunReference(
  store: ContinuationStore,
  reference: string,
  codebaseId: string | null | undefined,
  restrictToProject: boolean
): Promise<WorkflowRun | null> {
  if (isFullRunId(reference) && !restrictToProject) return store.getWorkflowRun(reference);
  if (!codebaseId) {
    throw new WorkflowContinuationError(
      `Cannot resolve run id prefix '${reference}' without a selected project. Select a project for the conversation.`
    );
  }
  const matches = await findProjectRunsByReference(store, reference, codebaseId);
  if (restrictToProject) return requireSelectedProjectMatch(matches, reference);
  if (matches.length > 1) {
    throw new WorkflowContinuationError(
      `Run id '${reference}' matches more than one run in this project:\n${matches.map(match => `  ${match.id}`).join('\n')}\nUse more characters or the full id.`
    );
  }
  return matches[0] ?? null;
}

function requireSelectedProjectMatch(matches: WorkflowRun[], reference: string): WorkflowRun {
  const run = matches.length === 1 ? matches[0] : undefined;
  if (
    !run ||
    (isFullRunId(reference) &&
      run.id.replaceAll('-', '').toLowerCase() !== reference.replaceAll('-', '').toLowerCase())
  ) {
    throw new WorkflowContinuationError(
      `Run id '${reference}' does not identify exactly one run in the selected project.`
    );
  }
  return run;
}
