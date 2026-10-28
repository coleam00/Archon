import { requireProvider } from '@archon/provider-contract';
import type { IAgentProvider, ProviderCapabilities } from '@archon/provider-contract';
import { type NodeExecutionRecord } from '../../../schemas/node-execution';
import { recordNodeState } from '../../../node-event-write';
import { isSourceReadFailure } from '../../../workflow-source';
import type { AgentNode, EffortLevel } from '../../../schemas';
import { readHomeMcpDirectory } from '../../../compiled-command';
import { safeSendMessage, type SendMessageContext } from '../../../platform-messages';
import { type TierName } from '../../../model-validation';
import { getLog } from '../../log';
import { assertNodeSourceReadable, RunSourceUnreadableError } from '../../node-source';
import {
  beginExecution,
  observeNodeCheckout,
  type RunLayersContext,
  type SessionResumeIntent,
} from '../../run-context';
import { isInsideAny } from '../../checkout-guard';
import { resolveNodeMcp, type NodeMcpResolution } from '../../provider-resolution';

/** The provider, model and session an agent attempt was dispatched with. */
export interface AgentBindingRequest {
  stepName: string;
  provider: string;
  reserveBudget: () => Promise<void>;
  resolvedModel: string | undefined;
  resolvedTier: TierName | undefined;
  resolvedEffort: EffortLevel | undefined;
  resumeSessionId: string | undefined;
  resumeIntent: SessionResumeIntent;
  /** The node named by `context: { resume }`, when it resumes one. */
  namedResumeSourceNodeId: string | undefined;
  /** Only inside a loop_group body; tags lifecycle rows with the iteration. */
  iteration: number | undefined;
  nodeContext: SendMessageContext;
}

export interface AgentBinding {
  capabilities: ProviderCapabilities;
  nodeMcp: Exclude<NodeMcpResolution, { kind: 'read_error' }>;
  aiClient: IAgentProvider;
  /** The started attempt, already recorded as running. */
  execution: NodeExecutionRecord;
}

/**
 * Binds the node to its provider and MCP servers, reserves budget, and records the attempt as
 * started. An unreadable MCP file inside the workflow source fails the run's source, not the node.
 */
export async function bindAgentNode(
  ctx: RunLayersContext,
  node: AgentNode,
  request: AgentBindingRequest
): Promise<AgentBinding> {
  const { deps, cwd, workflowSourceRoots } = ctx;
  const { stepName, provider, namedResumeSourceNodeId } = request;
  const homeMcpDirectory = readHomeMcpDirectory(node);
  const verifiedMcpFiles =
    homeMcpDirectory !== undefined
      ? await assertNodeSourceReadable(workflowSourceRoots, stepName)
      : undefined;
  const capabilities = requireProvider(deps.providers, provider).capabilities;
  const nodeMcp = await resolveNodeMcp(
    node.mcp,
    capabilities,
    cwd,
    homeMcpDirectory,
    verifiedMcpFiles
  );
  if (nodeMcp.kind === 'read_error') {
    const sourceRoot =
      workflowSourceRoots.kind === 'captured'
        ? workflowSourceRoots.anchor.root
        : workflowSourceRoots.globalWorkflows;
    if (
      homeMcpDirectory !== undefined &&
      isInsideAny(nodeMcp.path, [sourceRoot]) &&
      isSourceReadFailure(nodeMcp.error, verifiedMcpFiles)
    ) {
      throw new RunSourceUnreadableError(stepName, nodeMcp.error);
    }
    throw nodeMcp.error;
  }
  await request.reserveBudget();
  const aiClient = deps.getAgentProvider(provider);
  const execution: NodeExecutionRecord = {
    ...beginExecution(ctx, node, {
      provider,
      model: request.resolvedModel,
      tier: request.resolvedTier,
      effort: request.resolvedEffort,
      sessionId: request.resumeSessionId,
      capabilities,
      checkoutStart: await observeNodeCheckout(ctx),
    }),
    diagnostics: {
      ...(request.iteration !== undefined ? { iteration: request.iteration } : {}),
      ...(namedResumeSourceNodeId !== undefined
        ? {
            sessionSourceNodeId: namedResumeSourceNodeId,
            sessionForkRequested: request.resumeIntent !== 'owner-continuation',
          }
        : {}),
      ...(nodeMcp.kind === 'unavailable' ? { mcpUnavailable: nodeMcp.record } : {}),
    },
  };
  getLog().info({ nodeId: node.id, provider }, 'dag_node_started');
  await recordNodeState({ store: deps.store, logDir: ctx.logDir }, execution);
  if (nodeMcp.kind === 'unavailable') {
    const { record, fullPath } = nodeMcp;
    getLog().warn(
      { nodeId: node.id, path: record.path, fullPath, reason: record.reason },
      'dag.mcp_optional_unavailable'
    );
    const why =
      record.reason === 'provider_unsupported'
        ? `provider '${provider}' cannot load MCP servers`
        : (nodeMcp.diagnostic ?? `config file not found at ${fullPath}`);
    await safeSendMessage(
      ctx.platform,
      ctx.conversationId,
      `Node '${node.id}' runs without its optional MCP servers (${record.path}): ${why}.`,
      request.nodeContext
    );
  }
  return { capabilities, nodeMcp, aiClient, execution };
}
