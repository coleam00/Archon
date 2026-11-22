/**
 * `archon workflow landing`: record the branch an item's change lands on. Every fresh run
 * on the item, and on an item `part_of` it that records none, is then cut from that branch
 * and proposes against it. Recording alone does not check the remote: a work order may
 * record its branch before it exists, and each run checks it when it starts. With `--from`
 * the command first creates the branch on the project's remote from that start point,
 * leaving a branch that already exists where it is; a failed create records nothing.
 */
import { validateBranchName } from '@archon/git';
import {
  createLandingBranch,
  type CreatedLandingBranch,
} from '@archon/core/workflows/item-landing';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { projectRefForCodebase } from '@archon/core/operations/attention-queue';
import { findCodebaseForCheckoutPath } from '@archon/core/services/codebase-checkout-resolver';
import type { ItemLanding } from '@archon/workflows/schemas/item-landing';
import { readCallingNode } from '../utils/calling-node';
import { writeJsonLine } from '../utils/stdout';
import { inheritedWorkflowCodebase } from './workflow-shared';

export const WORKFLOW_LANDING_USAGE =
  'Usage: archon workflow landing --item <key> --branch <name> [--from <start-point>] [--json]';

export interface WorkflowLandingRequest {
  item: string;
  branch: string;
  /** Create the branch on the remote from this start point before recording it. */
  from?: string;
}

type Recorded = { landing: ItemLanding; create: CreatedLandingBranch | null };

async function record(
  host: WorkflowHost,
  cwd: string,
  request: WorkflowLandingRequest,
  env: NodeJS.ProcessEnv
): Promise<Recorded> {
  try {
    await validateBranchName(request.branch);
  } catch (error) {
    throw new Error(`--branch '${request.branch}' is not a valid branch name.`, { cause: error });
  }
  const codebase =
    (await inheritedWorkflowCodebase(host)) ??
    (await findCodebaseForCheckoutPath(cwd, host.records.codebases));
  if (!codebase) throw new Error('--item names an item in one registered project.');
  const create =
    request.from === undefined
      ? null
      : await createLandingBranch(codebase, request.branch, request.from);
  const landing = await host.deps.store.recordItemLanding({
    projectKey: projectRefForCodebase(codebase).key,
    key: request.item,
    branch: request.branch,
    fromRun: env.WORKFLOW_ID ? readCallingNode(env.WORKFLOW_ID, env) : null,
  });
  return { landing, create };
}

function createdText(request: WorkflowLandingRequest, create: CreatedLandingBranch): string {
  return create.status === 'created'
    ? `Created ${request.branch} on ${create.remote} from ${request.from} (${create.commit.slice(0, 12)}). `
    : `${request.branch} already exists on ${create.remote}; left as it is. `;
}

export async function workflowLandingCommand(
  host: WorkflowHost,
  cwd: string,
  request: WorkflowLandingRequest,
  json: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  try {
    const { landing, create } = await record(host, cwd, request, env);
    // `create` appears only when --from was given, so the record-only shape is unchanged.
    if (json) await writeJsonLine(create === null ? landing : { ...landing, create });
    else
      console.log(
        `${create === null ? '' : createdText(request, create)}Item ${request.item} lands on ${landing.branch}.`
      );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) await writeJsonLine({ ok: false, error: message });
    else console.error(`Error: ${message}`);
    return 1;
  }
}
