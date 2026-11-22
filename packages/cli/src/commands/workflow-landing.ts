/**
 * `archon workflow landing`: record the branch an item's change lands on. Every fresh run
 * on the item, and on an item `part_of` it that records none, is then cut from that branch
 * and proposes against it. Recording does not check the remote: a work order may record
 * its branch before pushing it, and each run checks it when it starts.
 */
import { validateBranchName } from '@archon/git';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { ItemLanding } from '@archon/workflows/schemas/item-landing';
import { readCallingNode } from '../utils/calling-node';
import { writeJsonLine } from '../utils/stdout';
import { type ItemTarget, NoRunItemError, resolveItemTarget } from './item-target';

export const WORKFLOW_LANDING_USAGE =
  'Usage: archon workflow landing --item <key>|--item-of <run-id> --branch <name> [--json]';

export type WorkflowLandingRequest = ItemTarget & { branch: string };

async function record(
  host: WorkflowHost,
  cwd: string,
  request: WorkflowLandingRequest,
  env: NodeJS.ProcessEnv
): Promise<{ key: string; landing: ItemLanding }> {
  try {
    await validateBranchName(request.branch);
  } catch (error) {
    throw new Error(`--branch '${request.branch}' is not a valid branch name.`, { cause: error });
  }
  const { projectKey, key } = await resolveItemTarget(host, cwd, request);
  const landing = await host.deps.store.recordItemLanding({
    projectKey,
    key,
    branch: request.branch,
    fromRun: env.WORKFLOW_ID ? readCallingNode(env.WORKFLOW_ID, env) : null,
  });
  return { key, landing };
}

export async function workflowLandingCommand(
  host: WorkflowHost,
  cwd: string,
  request: WorkflowLandingRequest,
  json: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  try {
    const { key, landing } = await record(host, cwd, request, env);
    if (json) await writeJsonLine(landing);
    else console.log(`Item ${key} lands on ${landing.branch}.`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json)
      await writeJsonLine({
        ok: false,
        error: error instanceof NoRunItemError ? 'no_item' : message,
      });
    else console.error(`Error: ${message}`);
    return 1;
  }
}
