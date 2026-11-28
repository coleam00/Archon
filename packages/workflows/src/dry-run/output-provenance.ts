import { loopPrevRefToken, type LoopBodyScope } from '../dag/loop-scope';
import { nodeOutputRefToken, type RequiredOutputRefContext } from '../dag/references';
import {
  parseWholeOutputRef,
  substituteTemplate,
  type JsonValue,
  type TemplateToken,
} from '../output-ref';
import { isBindingDirectiveShape, type NodeOutput } from '../schemas';

export function assertAuthoredOutput(
  output: NodeOutput | undefined,
  generatedOutputs: WeakSet<NodeOutput>
): void {
  if (output !== undefined && generatedOutputs.has(output))
    throw new Error(
      'Executable consumers require an authored stub or executed output, not a generated placeholder'
    );
}

export function authoredOutputReferences(
  outputs: Map<string, NodeOutput>,
  scopes: readonly LoopBodyScope[],
  generatedOutputs: WeakSet<NodeOutput>,
  requiredContext?: RequiredOutputRefContext
): { prior: TemplateToken[]; current: TemplateToken[] } {
  const guarded = (
    token: TemplateToken,
    sources: Map<string, NodeOutput> | undefined
  ): TemplateToken => ({
    pattern: token.pattern,
    resolve: match => {
      const resolved = token.resolve(match);
      if (resolved !== undefined) assertAuthoredOutput(sources?.get(match[1]), generatedOutputs);
      return resolved;
    },
  });
  const prior = scopes.map(scope => guarded(loopPrevRefToken(scope, false), scope.loopPrevOutputs));
  return {
    prior,
    current: [
      ...prior,
      guarded(nodeOutputRefToken(outputs, false, undefined, requiredContext), outputs),
    ],
  };
}

export function assertAuthoredBindings(
  values: readonly JsonValue[],
  outputs: Map<string, NodeOutput>,
  references: ReturnType<typeof authoredOutputReferences>
): void {
  for (const value of values) {
    if (typeof value === 'string') {
      substituteTemplate(value, references.current);
    } else if (isBindingDirectiveShape(value)) {
      const ref = parseWholeOutputRef(value.from);
      const producer = ref === undefined ? undefined : outputs.get(ref.nodeId);
      if (producer !== undefined && producer.state !== 'skipped' && producer.state !== 'pending') {
        substituteTemplate(value.from, references.current);
      } else if (typeof value.if_skipped === 'string') {
        substituteTemplate(value.if_skipped, references.prior);
      }
    }
  }
}
