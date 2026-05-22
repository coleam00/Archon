import { fromWorkflowDefinition, type BuilderNode } from '@archon/workflow-studio-core';

export interface ConversionResult {
  builderNodes: BuilderNode[] | null;
  conversionError: string | null;
}

export function tryFromWorkflowDefinition(
  raw: Record<string, unknown> | null | undefined
): ConversionResult {
  if (!raw) return { builderNodes: null, conversionError: null };
  try {
    const { nodes } = fromWorkflowDefinition(raw);
    return { builderNodes: nodes, conversionError: null };
  } catch (err) {
    return {
      builderNodes: null,
      conversionError: err instanceof Error ? err.message : String(err),
    };
  }
}
