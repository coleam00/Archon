/**
 * The environment an exec node receives from the engine as its run contract: where
 * this run keeps its artifacts, which run it is, and the node's bound inputs.
 *
 * A project command a node runs on the project's behalf, such as its test gate, is
 * not part of the run and must not see these. A gate that sees `WORKFLOW_ID` believes
 * it is inside the run, and any Archon command it starts then acts for that run.
 *
 * The engine owns the list as `EXEC_NODE_ENVIRONMENT_NAMES`. A pack script cannot
 * import engine code, so a conformance test beside the engine holds this copy to it.
 */
export const NODE_CONTRACT_ENV: readonly string[] = [
  'ARTIFACTS_DIR',
  'STATE_DIR',
  'LOG_DIR',
  'ADOPTED_RUN_DIR',
  'WORKFLOW_ID',
  'BASE_BRANCH',
  'USER_MESSAGE',
  'ARGUMENTS',
  'LOOP_USER_INPUT',
  'LOOP_PREV_OUTPUT',
  'REJECTION_REASON',
  'CONTEXT',
  'EXTERNAL_CONTEXT',
  'ISSUE_CONTEXT',
  'TYPED_ARTIFACTS_FILE',
  'ARCHON_NODE_EXECUTION',
];

/** A node's `with:` bindings arrive with this prefix. */
const BINDING_PREFIX = 'INPUTS_';

/** The node's environment without the run contract: what a project command should see. */
export function projectEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const contract = new Set(NODE_CONTRACT_ENV);
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !contract.has(key) && !key.startsWith(BINDING_PREFIX))
  );
}
