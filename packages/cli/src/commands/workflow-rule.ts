/**
 * `archon workflow rule`: record a ruling on an item of this project, or withdraw one.
 * A ruling is a decision recorded without a question having been asked; every later read
 * of the item shows it with the answers (`workflow runs --item`).
 */
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { projectRefForCodebase } from '@archon/core/operations/attention-queue';
import { recordItemRuling, withdrawItemRuling } from '@archon/core/operations/item-rulings';
import { findCodebaseForCheckoutPath } from '@archon/core/services/codebase-checkout-resolver';
import {
  ItemRulingNotFoundError,
  ItemRulingOutsideProjectError,
  ItemRulingWithdrawnError,
  type ItemRuling,
} from '@archon/workflows/schemas/item-ruling';
import { cliActor } from '../utils/calling-node';
import { writeJsonLine } from '../utils/stdout';
import { inheritedWorkflowCodebase } from './workflow-shared';

export const WORKFLOW_RULE_USAGE =
  'Usage: archon workflow rule --item <key> [--as <name>] [--json] -- <text>\n' +
  '       archon workflow rule --withdraw <ruling-id> [--as <name>] [--json]';

export type WorkflowRuleRequest =
  | { item: string; text: string; as?: string }
  | { withdraw: string; as?: string };

async function rule(
  host: WorkflowHost,
  cwd: string,
  request: WorkflowRuleRequest,
  env: NodeJS.ProcessEnv
): Promise<ItemRuling> {
  const actor = cliActor(request.as, env);
  const selected = await inheritedWorkflowCodebase(host);
  // A withdrawal names its ruling by id. Under a selected project it must be that
  // project's; without one it is not scoped, as a full run id is not.
  if ('withdraw' in request)
    return withdrawItemRuling(
      host.deps.store,
      {
        rulingId: request.withdraw,
        ...(selected ? { projectKey: projectRefForCodebase(selected).key } : {}),
      },
      actor,
      'cli'
    );
  // The project comes from the checkout, the same way `workflow runs --item` finds it.
  const codebase = selected ?? (await findCodebaseForCheckoutPath(cwd, host.records.codebases));
  if (!codebase) throw new Error('--item names an item in one registered project.');
  return recordItemRuling(
    host.deps.store,
    { projectKey: projectRefForCodebase(codebase).key, key: request.item, text: request.text },
    actor,
    'cli'
  );
}

/** The fixed code of a refusal a caller acts on; any other failure reports its message. */
function refusalCode(error: unknown): string | undefined {
  if (error instanceof ItemRulingNotFoundError) return 'not_found';
  if (error instanceof ItemRulingWithdrawnError) return 'already_withdrawn';
  if (error instanceof ItemRulingOutsideProjectError) return 'outside_project';
  return undefined;
}

export async function workflowRuleCommand(
  host: WorkflowHost,
  cwd: string,
  request: WorkflowRuleRequest,
  json: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  try {
    const ruling = await rule(host, cwd, request, env);
    if (json) await writeJsonLine(ruling);
    else if (ruling.withdrawn) console.log(`Ruling ${ruling.id} withdrawn.`);
    else console.log(`Ruling ${ruling.id} recorded.`);
    return 0;
  } catch (error) {
    // No message here repeats the ruling's text.
    const message = error instanceof Error ? error.message : String(error);
    if (json) await writeJsonLine({ ok: false, error: refusalCode(error) ?? message });
    else console.error(`Error: ${message}`);
    return 1;
  }
}
