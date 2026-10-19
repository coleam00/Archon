import { readComposedBindings } from '../../compiled-command';
import { inputEnvVars, resolveNodeBindings, substituteLoopBodyText } from '../../dag/references';
import type { NodeExecutionMetadata } from '../../schemas/node-execution';
import {
  isAgentNode,
  isExecNode,
  type AgentNode,
  type ExecNode,
  type NodeOutput,
} from '../../schemas';
import {
  TOLERATED_STUB_REASON,
  bindingShellContext,
  loadDryRunCommand,
  nodeType,
  recordFailed,
  resolveText,
  stubFor,
  withResolution,
  type DryRunContext,
} from '../context';
import { completedOutput, generatedStubFor, type DryRunStubValue } from '../stubs';
import { executeCodeNode } from './exec';

/** An agent or exec node: resolve its text, then hydrate a stub or, with `--exec-code`, run the code. */
export async function simulateAgentOrExec(
  node: AgentNode | ExecNode,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext,
  iteration?: number,
  execution?: NodeExecutionMetadata
): Promise<void> {
  const resolvedText = await resolveNodeText(node, outputs, ctx);
  const stub = stubFor(node, ctx);
  if (stub === undefined && isExecNode(node) && ctx.execCode) {
    await executeLocally(node, resolvedText, outputs, ctx, iteration, execution);
    return;
  }
  hydrateStub(node, stub, resolvedText, outputs, ctx, iteration);
}

async function resolveNodeText(
  node: AgentNode | ExecNode,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext
): Promise<string> {
  const sourceText = isAgentNode(node)
    ? node.source.kind === 'command'
      ? await loadDryRunCommand(
          ctx,
          node,
          substituteLoopBodyText(node.source.name, ctx.loopBodyScopes)
        )
      : node.source.prompt
    : node.script;
  // Node-local `with:` bindings (#2637) resolve BEFORE the stub check, exactly as
  // the executor resolves them before execution — a binding a real run would fail
  // on (unknown producer, skipped without if_skipped) fails the simulated node
  // with the executor's own error, via `simulateNode`'s catch. Command bindings merge
  // over run inputs into the `$INPUTS` bag; script bindings ride the exec env.
  // A composed command node carries its map in the engine-private payload, having
  // been materialized into an inline prompt at expansion (#2964).
  const nodeWith = isExecNode(node)
    ? node.with
    : node.source.kind === 'command'
      ? node.source.with
      : readComposedBindings(node);
  const nodeBindings =
    nodeWith !== undefined
      ? resolveNodeBindings(node.id, nodeWith, bindingShellContext(ctx, outputs), ctx.inputs)
      : undefined;
  const commandInputs =
    isAgentNode(node) && nodeBindings !== undefined
      ? { ...(ctx.inputs ?? {}), ...nodeBindings }
      : undefined;
  return resolveText(
    sourceText,
    ctx,
    outputs,
    isExecNode(node) ? (node.runtime === 'sh' ? 'shell' : 'script') : 'prompt',
    '',
    commandInputs
  );
}

async function executeLocally(
  node: ExecNode,
  resolvedText: string,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext,
  iteration?: number,
  execution?: NodeExecutionMetadata
): Promise<void> {
  const executed = await executeCodeNode(
    node,
    resolvedText,
    ctx,
    inputEnvVars(node, bindingShellContext(ctx, outputs), ctx.inputs),
    execution
  );
  if ('error' in executed) {
    recordFailed(node, outputs, ctx, executed.error, resolvedText, iteration);
    return;
  }
  outputs.set(node.id, { state: 'completed', ...executed });
  ctx.trace.push({
    nodeId: node.id,
    nodeType: nodeType(node),
    state: 'completed',
    reason: 'executed locally',
    resolvedText,
    output: executed.output,
    ...(iteration ? { iteration } : {}),
  });
}

function hydrateStub(
  node: AgentNode | ExecNode,
  stub: DryRunStubValue | undefined,
  resolvedText: string,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext,
  iteration?: number
): void {
  // `trigger_rule: all_done` declares this node a barrier/join that runs regardless
  // of upstream outcome — a real run reaches it independent of dry-run fixture data,
  // so a missing stub here is an authoring gap, not evidence the simulated run would
  // fail (#2869). Tolerate it the way `--default-stubs` tolerates any missing stub —
  // a generated placeholder — while still reporting the gap via `missingStubs` (and,
  // since the gap never blocks this node, `toleratedMissingStubs`) so the fixture
  // stays honest about what it never verified.
  const tolerated = stub === undefined && node.trigger_rule === 'all_done';
  if (stub !== undefined || tolerated) {
    if (tolerated) ctx.missingStubs.add(node.id);
    // The tolerance claim waits for the placeholder to exist. `generatedStubFor`
    // throws on an `output_format` it cannot satisfy, and `simulateNode`'s catch
    // then fails the node — so a node added to `toleratedMissingStubs`
    // any earlier would report a gap that never blocked it while that gap is
    // exactly what blocked it, and `checkFixture` would filter the blocker away.
    const hydrated = completedOutput(node, stub ?? generatedStubFor(node));
    if (tolerated) ctx.toleratedMissingStubs.add(node.id);
    outputs.set(node.id, hydrated);
    ctx.trace.push({
      nodeId: node.id,
      nodeType: nodeType(node),
      state: 'stubbed',
      ...(tolerated ? { reason: TOLERATED_STUB_REASON } : {}),
      resolvedText,
      output: hydrated.output,
      ...(iteration ? { iteration } : {}),
      ...withResolution(node, ctx),
    });
    return;
  }
  ctx.missingStubs.add(node.id);
  recordFailed(
    node,
    outputs,
    ctx,
    `Missing reachable stub for node '${node.id}'`,
    resolvedText,
    iteration
  );
}
