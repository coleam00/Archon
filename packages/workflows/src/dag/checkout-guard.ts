import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink } from 'node:fs/promises';
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

type CheckoutContent =
  | { kind: 'file'; value: string }
  | { kind: 'symlink'; value: string }
  | { kind: 'missing' | 'other'; value: number };

type CheckoutSnapshot = ReadonlyMap<string, { status: string; content: CheckoutContent }>;

async function fingerprint(path: string): Promise<CheckoutContent> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { kind: 'missing', value: 0 };
    }
    throw error;
  }
  if (stat.isSymbolicLink()) return { kind: 'symlink', value: await readlink(path) };
  if (!stat.isFile()) return { kind: 'other', value: stat.mode };
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { kind: 'file', value: hash.digest('hex') };
}

/**
 * Observe Git-visible dirty paths, excluding engine-owned roots. Unavailable Git
 * or filesystem observations skip the assertion rather than compare partial data.
 */
export async function snapshotCheckout(
  cwd: string,
  excludeDirs: readonly string[]
): Promise<CheckoutSnapshot | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { cwd, timeout: 10_000 }
    );
    const snapshot = new Map<string, { status: string; content: CheckoutContent }>();
    if (stdout === '') return snapshot;
    // Keep cwd's lexical spelling: Git's absolute root may resolve aliases such as
    // macOS /var, while the engine's excluded roots retain that alias.
    const { stdout: root } = await execFileAsync('git', ['rev-parse', '--show-cdup'], {
      cwd,
      timeout: 10_000,
    });
    const repositoryRoot = resolvePath(cwd, root.replace(/\r?\n$/, ''));
    const records = stdout.split('\0');
    for (let i = 0; i < records.length - 1; i++) {
      const record = records[i];
      const status = record.slice(0, 2);
      const paths = [record.slice(3)];
      // Porcelain -z places the destination first and the rename/copy source next.
      if (status.includes('R') || status.includes('C')) paths.push(records[++i]);
      for (const path of paths) {
        const absolute = resolvePath(repositoryRoot, path);
        if (isInsideAny(absolute, excludeDirs) || snapshot.has(path)) continue;
        snapshot.set(path, { status, content: await fingerprint(absolute) });
      }
    }
    return snapshot;
  } catch (error) {
    // A partial observation cannot establish that the checkout stayed unchanged.
    getLog().warn({ cwd, err: error }, 'dag_checkout_snapshot_unavailable');
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
): Promise<CheckoutSnapshot | undefined> {
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
  before: CheckoutSnapshot | undefined,
  result: NodeExecutionResult,
  deps: WorkflowDeps,
  logDir: string,
  guardedLayerSnapshots: ReadonlySet<string> | undefined
): Promise<NodeExecutionResult> {
  if (node.mutates_checkout !== false || before === undefined || result.state !== 'completed') {
    return result;
  }
  const after = await snapshotCheckout(cwd, excludeDirs);
  if (after === undefined) return result;
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(path => {
    const a = before.get(path);
    const b = after.get(path);
    return (
      a === undefined ||
      b === undefined ||
      a.status !== b.status ||
      a.content.kind !== b.content.kind ||
      a.content.value !== b.content.value
    );
  });
  if (changed.length === 0) return result;
  const changedPaths = changed.sort().slice(0, 10).join(', ');
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
