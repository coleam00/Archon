import {
  resolveTopLevelInputs,
  WorkflowMissingInputsError,
} from '@archon/workflows/utils/workflow-requirements';
import { WorkflowInputContractError } from '@archon/workflows/workflow-inputs';
import { startWorkflow } from '../handlers/commands/workflow';
import type { Conversation } from '../types';

/**
 * Why a start of `workflowName` with these inputs cannot run, or `undefined` when it can:
 * the workflow does not resolve, or its declared inputs refuse the supplied values. The
 * run route asks before it writes or dispatches anything, so it can answer the request
 * itself. It is the check CLI admission makes, through the same {@link resolveTopLevelInputs},
 * against the workflow the conversation's project resolves. The dispatch gate still judges
 * the definition a run executes, which an adopted branch can replace.
 *
 * A conversation with no row yet resolves workflows as one with no project does.
 */
export async function workflowStartRefusal(
  conversation: Pick<Conversation, 'codebase_id' | 'cwd'> | null,
  workflowName: string,
  inputs: Readonly<Record<string, string>> | undefined
): Promise<string | undefined> {
  const start = await startWorkflow(
    conversation ?? { codebase_id: null, cwd: null },
    workflowName,
    '',
    false,
    {}
  );
  if (start.workflow?.kind !== 'start') return start.message;
  try {
    resolveTopLevelInputs(start.workflow.definition, inputs);
  } catch (err) {
    if (err instanceof WorkflowMissingInputsError || err instanceof WorkflowInputContractError)
      return err.message;
    throw err;
  }
  return undefined;
}
