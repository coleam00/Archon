/**
 * `archon workflow end`: end an item of this project, saying nothing more will happen on
 * it. The item rests: its stop leaves `workflow attention`, and `workflow runs --item`
 * shows who ended it and why, until a newer run, a resume or a new start opens it again.
 */
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { projectRefForCodebase } from '@archon/core/operations/attention-queue';
import { recordItemEnd } from '@archon/core/operations/item-ends';
import { findCodebaseForCheckoutPath } from '@archon/core/services/codebase-checkout-resolver';
import {
  ItemEndNotFoundError,
  ItemEndRefusedError,
  type ItemEnd,
} from '@archon/workflows/schemas/item-end';
import { cliActor } from '../utils/calling-node';
import { writeJsonLine } from '../utils/stdout';
import { inheritedWorkflowCodebase } from './workflow-shared';

export const WORKFLOW_END_USAGE =
  'Usage: archon workflow end --item <key> [--as <name>] [--json] -- <reason>';

export interface WorkflowEndRequest {
  item: string;
  reason: string;
  as?: string;
}

async function end(
  host: WorkflowHost,
  cwd: string,
  request: WorkflowEndRequest,
  env: NodeJS.ProcessEnv
): Promise<ItemEnd> {
  // The project comes from the checkout, the same way `workflow runs --item` finds it.
  const codebase =
    (await inheritedWorkflowCodebase(host)) ??
    (await findCodebaseForCheckoutPath(cwd, host.records.codebases));
  if (!codebase) throw new Error('--item names an item in one registered project.');
  return recordItemEnd(
    host.deps.store,
    { projectKey: projectRefForCodebase(codebase).key, key: request.item, reason: request.reason },
    cliActor(request.as, env),
    'cli'
  );
}

export async function workflowEndCommand(
  host: WorkflowHost,
  cwd: string,
  request: WorkflowEndRequest,
  json: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  try {
    const ended = await end(host, cwd, request, env);
    if (json) await writeJsonLine(ended);
    else console.log(`Item ${request.item} ended.`);
    return 0;
  } catch (error) {
    // No message here repeats the reason.
    const message = error instanceof Error ? error.message : String(error);
    if (json)
      await writeJsonLine(
        error instanceof ItemEndRefusedError
          ? { ok: false, error: error.blocker.kind, blocker: error.blocker, message }
          : { ok: false, error: error instanceof ItemEndNotFoundError ? 'not_found' : message }
      );
    else console.error(`Error: ${message}`);
    return 1;
  }
}
