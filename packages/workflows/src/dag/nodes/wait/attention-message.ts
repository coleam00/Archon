import { inputRefToken, substituteTemplate } from '../../../output-ref';
import {
  readWorkflowWaitContext,
  type WorkflowAttentionWaitContext,
} from '../../../schemas/workflow-run';
import { nodeTemplateReferences, resolveRunInputs, substituteWaitMessage } from '../../references';
import { waitCondition, type WaitNode } from '../../../schemas/wait-node';
import type { WaitLoopOwner } from './wait';
import type { RunLayersContext } from '../../run-context';
import { loopScopeTokens } from '../../loop-scope';

interface WaitMessageRenderer {
  render: (text: string) => string;
  pauseFields: Pick<WorkflowAttentionWaitContext, 'loopQuestionReferences'>;
}

/** Freeze only loop references: current upstream outputs must still be observed on resume. */
function attentionMessageRenderer(
  ctx: RunLayersContext,
  persisted?: WorkflowAttentionWaitContext
): WaitMessageRenderer {
  const references = { ...persisted?.loopQuestionReferences };
  const frozen = (match: RegExpExecArray): string => {
    if (!Object.hasOwn(references, match[0])) {
      throw new Error(
        `Cannot validate answered loop wait: missing question reference '${match[0]}'. Restart the run to ask a fresh question.`
      );
    }
    return references[match[0]];
  };
  return {
    pauseFields: { loopQuestionReferences: references },
    render: text => {
      const { before, after } = nodeTemplateReferences(text, ctx);
      const referenceTokens = loopScopeTokens(
        { loopPrevOutputs: undefined, loopUserInput: '' },
        'prompt'
      ).map(token => ({
        pattern: token.pattern,
        resolve: persisted !== undefined ? frozen : (match: RegExpExecArray) => match[0],
      }));
      const loopTokens =
        persisted !== undefined
          ? referenceTokens
          : [...before, ...referenceTokens].map(token => ({
              pattern: token.pattern,
              resolve: (match: RegExpExecArray) => {
                const value = token.resolve(match);
                if (value !== undefined) references[match[0]] = value;
                return value;
              },
            }));
      return substituteTemplate(text, [
        ...loopTokens,
        inputRefToken(resolveRunInputs(ctx.workflowRun)),
        ...after,
      ]);
    },
  };
}

export function waitMessageRenderer(
  ctx: RunLayersContext,
  node: WaitNode,
  owner: WaitLoopOwner | undefined
): WaitMessageRenderer {
  if (owner === undefined || waitCondition(node.wait).kind !== 'attention') {
    return {
      render: text => substituteWaitMessage(text, ctx, resolveRunInputs(ctx.workflowRun)),
      pauseFields: {},
    };
  }
  const raw = readWorkflowWaitContext(ctx.workflowRun.metadata?.wait);
  const persisted =
    raw?.owner === 'loop_group' &&
    raw.nodeId === owner.groupId &&
    raw.bodyWaitId === node.id &&
    raw.iteration === owner.iteration &&
    raw.kind === 'attention'
      ? raw
      : undefined;
  return attentionMessageRenderer(ctx, persisted);
}
