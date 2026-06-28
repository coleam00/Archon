import type {
  NodeOutput,
  RouteLoopConfig,
  RouteOutcome,
  RouteLoopRuntimeMetadata,
} from './schemas';
import { serializeSafeCondition } from './condition-evaluator';
import { routeLoopRuntimeMetadataSchema } from './schemas';

export interface RouteLoopTransitionInput {
  metadata: Record<string, unknown>;
  routeLoopNodeId: string;
  routeLoop: RouteLoopConfig;
  conditionResult: boolean;
}

export interface RouteLoopDecisionData extends Record<string, unknown> {
  from: string;
  outcome: RouteOutcome;
  to: string;
  condition: string;
  condition_result: boolean;
  negative_count: number;
  max_iterations: number;
  attempt: number;
  execution_seq: number;
}

export interface RouteLoopTransitionResult {
  metadata: RouteLoopRuntimeMetadata;
  eventData: RouteLoopDecisionData;
  output: NodeOutput;
}

export function serializeSafeRouteCondition(condition: string): string {
  return serializeSafeCondition(condition);
}

export function applyRouteLoopTransition(
  input: RouteLoopTransitionInput
): RouteLoopTransitionResult {
  const current = routeLoopRuntimeMetadataSchema.parse(input.metadata);
  const currentNegativeCount = current.loopCounters[input.routeLoopNodeId] ?? 0;
  const attempt = (current.nodeAttempts[input.routeLoopNodeId] ?? 0) + 1;
  const executionSeq = current.executionSeq + 1;

  let outcome: RouteOutcome;
  let targetNodeId: string;
  let negativeCount = currentNegativeCount;
  let nextLoopCounter: number;

  if (input.conditionResult) {
    outcome = 'positive';
    targetNodeId = input.routeLoop.routes.positive;
    nextLoopCounter = 0;
  } else {
    negativeCount = currentNegativeCount + 1;
    outcome =
      negativeCount > input.routeLoop.max_iterations
        ? ('exhausted' as const)
        : ('negative' as const);
    targetNodeId =
      outcome === 'exhausted' ? input.routeLoop.routes.exhausted : input.routeLoop.routes.negative;
    nextLoopCounter = negativeCount;
  }

  const eventData: RouteLoopDecisionData = {
    from: input.routeLoop.from,
    outcome,
    to: targetNodeId,
    condition: serializeSafeRouteCondition(input.routeLoop.condition),
    condition_result: input.conditionResult,
    negative_count: negativeCount,
    max_iterations: input.routeLoop.max_iterations,
    attempt,
    execution_seq: executionSeq,
  };

  const metadata: RouteLoopRuntimeMetadata = {
    ...current,
    loopCounters: {
      ...current.loopCounters,
      [input.routeLoopNodeId]: nextLoopCounter,
    },
    nodeAttempts: {
      ...current.nodeAttempts,
      [input.routeLoopNodeId]: attempt,
    },
    executionSeq,
    routeActivations: {
      ...current.routeActivations,
      [targetNodeId]: {
        route_loop_node_id: input.routeLoopNodeId,
        outcome,
        target_node_id: targetNodeId,
        attempt,
        execution_seq: executionSeq,
      },
    },
  };

  const outputText = JSON.stringify(eventData);

  return {
    metadata,
    eventData,
    output: {
      state: 'completed',
      output: outputText,
      structuredOutput: eventData,
      declaredFields: Object.keys(eventData),
    },
  };
}
