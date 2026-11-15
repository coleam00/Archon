import type { RunActor } from '@archon/core/operations/run-authorization';
import { nodeExecutionMetadataSchema } from '@archon/workflows/schemas/node-execution';

/** The run and node a CLI call made from inside a workflow node acts for. */
export interface CallingNode {
  runId: string;
  nodePath: string;
}

/**
 * The node identity the engine hands a node process, checked against `WORKFLOW_ID`.
 * Callers verify that their store knows the run; this only reads the environment.
 */
export function readCallingNode(runId: string, env: NodeJS.ProcessEnv): CallingNode {
  let supplied: unknown = null;
  try {
    supplied = JSON.parse(env.ARCHON_NODE_EXECUTION || 'null');
  } catch {
    // Reported below with the same message as a missing identity.
  }
  const parsedIdentity = nodeExecutionMetadataSchema
    .pick({ runId: true, path: true })
    .safeParse(supplied);
  if (!parsedIdentity.success)
    throw new Error('WORKFLOW_ID requires ARCHON_NODE_EXECUTION as JSON with runId and path');
  const identity = parsedIdentity.data;
  if (identity.runId !== runId) throw new Error('ARCHON_NODE_EXECUTION does not match WORKFLOW_ID');
  return { runId, nodePath: identity.path };
}

/**
 * The CLI's actor: the operator, with the name `--as` declared for whoever is answering.
 * The name is a claim recorded with an attention wait's answer; a gate answer refuses it.
 * A call made inside a workflow node also carries that run and node, read from the
 * identity the engine put in the node's environment and never from an argument.
 */
export function cliActor(
  declared: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): RunActor {
  return {
    kind: 'operator',
    ...(declared === undefined ? {} : { declared }),
    ...(env.WORKFLOW_ID ? { fromRun: readCallingNode(env.WORKFLOW_ID, env) } : {}),
  };
}
