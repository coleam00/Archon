import { resolve as resolvePath } from 'path';
import { isPathInside } from '@archon/paths';
import { execFileAsync } from '@archon/git';
import { type DagNode, isExecNode, isAgentNode } from '../schemas';
import type { NodeExecutionResult } from '../node-record-serialization';
import type { WorkflowDeps } from '../deps';
import { recordNodeState } from '../node-event-write';
import { finishNodeExecution } from '../node-execution';
import type { RunLayersContext } from './run-context';
import { getLog } from './log';

/**
 * Absolute directories a run writes into by engine design (artifacts, state, logs).
 * Changes under them never count against a node's `mutates_checkout: false`
 * assertion (#2771) — extend here if another engine-write root appears.
 */
export function checkoutSnapshotExcludes(
  artifactsDir: string,
  stateDir: string,
  logDir: string
): readonly string[] {
  return [artifactsDir, stateDir, logDir].map(d => resolvePath(d));
}

export function isInsideAny(absPath: string, dirs: readonly string[]): boolean {
  return dirs.some(d => isPathInside(d, absPath, { includeRoot: true, lexical: true }));
}

/** Path operands of one `git status --porcelain` line (`XY path` or `XY old -> new`). */
export function porcelainPaths(line: string): string[] {
  const body = line.slice(3);
  const unquote = (p: string): string =>
    p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
  return (body.includes(' -> ') ? body.split(' -> ') : [body]).map(unquote);
}

/**
 * Snapshot the working tree's dirty state (`git status --porcelain`) for a node's
 * `mutates_checkout: false` assertion (#2771), dropping entries under `excludeDirs`.
 * Returns `undefined` when the check cannot run — cwd outside a repo, or git failing
 * — so a broken assertion degrades to no check rather than breaking unrelated runs.
 */
export async function snapshotCheckout(
  cwd: string,
  excludeDirs: readonly string[]
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      // core.quotePath=false keeps non-ASCII paths literal instead of C-escaped, so
      // exclusion matching against real directory names cannot miss them.
      ['-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=normal'],
      { cwd, timeout: 10_000 }
    );
    const relevant = stdout
      .split('\n')
      .filter(line => line.length > 3)
      .filter(
        line => !porcelainPaths(line).some(p => isInsideAny(resolvePath(cwd, p), excludeDirs))
      );
    return relevant.join('\n');
  } catch {
    return undefined;
  }
}

/**
 * Take a `mutates_checkout: false` node's pre-run snapshot and record it in its
 * concurrent layer's snapshot set, so a sibling's violation can name it. Returns
 * `undefined` for an undeclared node: nothing to assert.
 */
export async function snapshotGuardedNode(
  ctx: Pick<RunLayersContext, 'cwd' | 'guardedLayerSnapshots'>,
  node: DagNode,
  excludeDirs: readonly string[]
): Promise<string | undefined> {
  if (node.mutates_checkout !== false) return undefined;
  ctx.guardedLayerSnapshots?.add(node.id);
  return snapshotCheckout(ctx.cwd, excludeDirs);
}

/**
 * A node whose `mutates_checkout: false` the engine enforces: exec and agent nodes.
 * Every other node may write to the checkout as far as layer scheduling knows.
 */
export function isCheckoutGuarded(node: DagNode): boolean {
  return node.mutates_checkout === false && (isExecNode(node) || isAgentNode(node));
}

/**
 * Enforce a node's `mutates_checkout: false` declaration (#2771): when the node ran
 * successfully but the pre-run snapshot changed, rewrite its result to a failure that
 * names the node and lists what moved, and persist the standard `node_failed` event so
 * the violation surfaces like any other node failure. Applied OUTSIDE the retry loop so
 * the failure is non-retryable by construction — retrying a node that provably mutates
 * would only multiply the damage. A node that already failed keeps its own attributable
 * outcome; an absent snapshot (`undefined`) means the check could not run and is skipped.
 */
export async function assertCheckoutUntouched(
  node: DagNode,
  cwd: string,
  excludeDirs: readonly string[],
  before: string | undefined,
  result: NodeExecutionResult,
  deps: WorkflowDeps,
  logDir: string,
  guardedLayerSnapshots: ReadonlySet<string> | undefined
): Promise<NodeExecutionResult> {
  if (node.mutates_checkout !== false || before === undefined || result.state !== 'completed') {
    return result;
  }
  const after = await snapshotCheckout(cwd, excludeDirs);
  if (after === undefined || after === before) {
    return result;
  }
  const changedPaths = after
    .split('\n')
    .filter(Boolean)
    .flatMap(porcelainPaths)
    .slice(0, 10)
    .join(', ');
  const concurrentGuardedSiblings = [...(guardedLayerSnapshots ?? [])].filter(id => id !== node.id);
  const error =
    concurrentGuardedSiblings.length === 0
      ? `Node \`${node.id}\` declared \`mutates_checkout: false\` but modified the working tree: ${changedPaths}`
      : `Node \`${node.id}\` declared \`mutates_checkout: false\`, and the working tree changed; the guarded siblings ${concurrentGuardedSiblings.map(id => `\`${id}\``).join(', ')} also ran in this parallel layer, so the change may not be this node's alone: ${changedPaths}`;
  getLog().error({ nodeId: node.id, changed: changedPaths }, 'dag_mutates_checkout_violation');
  if (result.execution === undefined) {
    throw new Error(`Node '${node.id}' completed without its execution record`);
  }
  // This amends an already-recorded attempt. Keep its facts without charging its spend twice.
  const amended = await recordNodeState(
    { store: deps.store, logDir },
    finishNodeExecution(
      { ...result.execution, accounting: 'amendment' },
      { status: 'failed', error, failureKind: 'output_contract' },
      {
        output: {
          text: result.output,
          structured: result.structuredOutput,
          declaredOutputPaths: result.declaredOutputPaths,
        },
      }
    )
  );
  // Retry accounting is the accumulated cost of all attempts, not only the amended last one.
  return {
    ...amended,
    costUsd: result.costUsd,
    tokens: result.tokens,
    tokensUnknown: result.tokensUnknown,
  };
}
