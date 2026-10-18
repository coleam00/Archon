/**
 * Dispatch one admitted node to the executor for its kind.
 */
import { executeApprovalNode } from './nodes/gate/gate';
import { executeWaitNode } from './nodes/wait/wait';
import { executeHaltNode } from './nodes/halt/halt';
import { executeLoopNode } from './nodes/loop/loop';
import { executeLoopGroupNode } from './nodes/loop-group/loop-group';
import { executeWorkflowNode } from './nodes/workflow/workflow';
import { executeComposeFanOutNode } from './nodes/compose-fan-out/compose-fan-out';
import { runExecNode } from './nodes/exec/exec';
import { dispatchAgentNode } from './nodes/agent/dispatch';
import { snapshotBodySessionCursorAncestry } from './pause';
import type { DagNode } from '../schemas';
import { writeNodeArtifactsListing } from '../artifacts-index';
import { assistantModelDefaults, resolveNodeModelScope } from '../node-model-resolution';
import { aiConfigTextResolver } from './references';
import { resolveNodeProviderAndModel } from './provider-resolution';
import { type LayerNodeResult, type RunLayersContext, sessionCheckpoint } from './run-context';

/**
 * `isParallelLayer` is whether the node shares its layer with siblings; an agent node
 * then starts a fresh session rather than continuing the sequential one.
 */
export async function dispatchNode(
  ctx: RunLayersContext,
  node: DagNode,
  isParallelLayer: boolean
): Promise<LayerNodeResult> {
  // A real `switch (node.kind)` (not a chain of `isXNode` guards) so the compiler
  // enforces exhaustiveness: the `default` branch's `never` assignment fails to compile
  // the moment a new `DagNode` kind is added without a matching `case` here (AC1).
  switch (node.kind) {
    case 'exec': {
      return { nodeId: node.id, output: await runExecNode(ctx, node) };
    }

    case 'loop': {
      // Materialized before provider resolution so AI-configuration text can
      // reference the listing. executeLoopNode materializes its own fresh
      // observation for each iteration's prompt and until_bash.
      const typedArtifactsFile = await writeNodeArtifactsListing(
        ctx.artifactsDir,
        ctx.workflowRun.id
      );
      // Loop node dispatch — manages its own AI sessions and iteration
      const {
        provider: loopProvider,
        options: loopOptions,
        model: resolvedLoopModel,
        tier: resolvedLoopTier,
        effort: resolvedLoopEffort,
      } = await resolveNodeProviderAndModel(ctx, node, {
        resolveAiText: aiConfigTextResolver(ctx, typedArtifactsFile),
        warnedProviderConflicts: ctx.warnedProviderConflicts,
      });

      const output = await executeLoopNode(
        ctx,
        node,
        loopProvider,
        loopOptions,
        resolvedLoopModel,
        resolvedLoopTier,
        resolvedLoopEffort,
        sessionCheckpoint(ctx, node, loopProvider)
      );
      // Loop nodes run every iteration on the same resolved provider, so the
      // result session (if any) is attributable to loopProvider — tag it so a
      // downstream sequential node on a different provider starts fresh (#1992).
      return { nodeId: node.id, output, sessionProvider: loopProvider };
    }

    case 'loop_group': {
      // Materialized before provider resolution for the group's AI-configuration
      // text. Body nodes re-enter runLayers and establish their own observation.
      const typedArtifactsFile = await writeNodeArtifactsListing(
        ctx.artifactsDir,
        ctx.workflowRun.id
      );
      // Loop-group node dispatch — manages its own subgraph iteration
      // (body is a sealed sub-DAG re-executed per iteration; the loop is
      // encapsulated inside this one node, keeping the outer DAG acyclic).
      // Resolve provider and model for the group: both are forwarded to body
      // AI nodes as their defaults. The group itself never calls sendQuery, so
      // the resolved SendQueryOptions are not needed here.
      const groupScope = resolveNodeModelScope(
        node,
        {
          provider: ctx.workflowProvider,
          model: ctx.workflowModel,
          preset: ctx.workflowPreset,
          tier: ctx.workflowLevelOptions.workflowTier,
          effort: ctx.workflowLevelOptions.effort,
          providerOrigin: 'workflow',
        },
        assistantModelDefaults(ctx.config),
        ctx.aiProfile
      );
      const {
        provider: loopGroupProvider,
        model: loopGroupModel,
        tier: loopGroupTier,
        preset: loopGroupPreset,
      } = groupScope.provider === undefined
        ? groupScope
        : await resolveNodeProviderAndModel(ctx, node, {
            resolveAiText: aiConfigTextResolver(ctx, typedArtifactsFile),
            warnedProviderConflicts: ctx.warnedProviderConflicts,
          });

      const output = await executeLoopGroupNode(
        ctx,
        node,
        loopGroupProvider,
        loopGroupModel,
        loopGroupTier,
        loopGroupPreset
      );
      return { nodeId: node.id, output };
    }

    case 'gate': {
      // Approval node dispatch — pauses workflow for human review
      const output = await executeApprovalNode(ctx, node);
      return { nodeId: node.id, output };
    }

    case 'wait': {
      const loopFrame = ctx.loopGroupPath.at(-1);
      const output = await executeWaitNode(
        ctx,
        node,
        loopFrame === undefined
          ? undefined
          : {
              groupId: loopFrame.groupId,
              iteration: loopFrame.iteration,
              sessionId: ctx.lastSequentialSession?.sessionId ?? null,
              sessionProvider: ctx.lastSequentialSession?.provider ?? null,
              ...(ctx.bodySessionCursors !== undefined
                ? { bodySessionCursors: Object.fromEntries(ctx.bodySessionCursors) }
                : {}),
              ...snapshotBodySessionCursorAncestry(ctx.bodySessionCursorAncestry),
            }
      );
      return { nodeId: node.id, output };
    }

    case 'halt': {
      return { nodeId: node.id, output: await executeHaltNode(ctx, node) };
    }

    case 'workflow': {
      // Workflow (sub-run) node dispatch — starts/re-inspects a child run
      // (#2121 Phase 2). Makes no direct provider call; the closure captured on
      // ctx.runChildWorkflow drives the child's own executeWorkflow. The
      // output_type sidecar is handled by the shared completed-node path;
      // node_completed is written inline by executeWorkflowNode itself (see
      // asCompleted — only on true completion, never on the paused branch).
      const output = await executeWorkflowNode(node, ctx);
      return { nodeId: node.id, output };
    }

    case 'compose_fan_out': {
      // Composed fan-out dispatch (#2512): per-item in-parent expansion. Like
      // the sub-run wrapper it makes no provider call of its own and writes its
      // own completion/failure events.
      const output = await executeComposeFanOutNode(node, ctx, node.fan_out);
      return { nodeId: node.id, output };
    }

    case 'agent':
      return dispatchAgentNode(ctx, node, isParallelLayer);

    default: {
      const unreachable: never = node;
      throw new Error(
        `unreachable: node '${(unreachable as { id: string }).id}' matched no dispatch branch`
      );
    }
  }
}
