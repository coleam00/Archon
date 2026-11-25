/**
 * The re-run link: a run's console path with the query the draft card reads to start
 * the same run again (workflow, message, and the declared inputs it was supplied with).
 */
import type { Run } from '../primitives/run';

const RERUN = 'rerun';
const WORKFLOW = 'workflow';
const MESSAGE = 'message';
const INPUT_PREFIX = 'input.';

export interface Rerun {
  workflow: string;
  message: string | null;
  inputs: Record<string, string>;
}

export function rerunPath(
  run: Pick<Run, 'workflow' | 'userMessage' | 'suppliedInputs'> & { projectId: string }
): string {
  const params = new URLSearchParams({ [RERUN]: '1', [WORKFLOW]: run.workflow });
  if (run.userMessage !== '') params.set(MESSAGE, run.userMessage);
  for (const [name, value] of Object.entries(run.suppliedInputs ?? {}))
    params.set(`${INPUT_PREFIX}${name}`, value);
  return `/console/p/${run.projectId}?${params.toString()}`;
}

/**
 * The re-run a query asks for, and the query without it, so a reload does not
 * re-trigger it. Null when the query is not a re-run.
 */
export function takeRerun(params: URLSearchParams): { rerun: Rerun; rest: URLSearchParams } | null {
  if (params.get(RERUN) !== '1') return null;
  const rest = new URLSearchParams();
  const inputs: Record<string, string> = {};
  for (const [key, value] of params) {
    if (key.startsWith(INPUT_PREFIX)) inputs[key.slice(INPUT_PREFIX.length)] = value;
    else if (key !== RERUN && key !== WORKFLOW && key !== MESSAGE) rest.append(key, value);
  }
  return {
    rerun: { workflow: params.get(WORKFLOW) ?? '', message: params.get(MESSAGE), inputs },
    rest,
  };
}
