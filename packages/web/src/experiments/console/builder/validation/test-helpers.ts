/**
 * Shared helpers for validation tests. Test-only — intentionally not exported
 * from the package barrels.
 */
import type { BuilderNode, BuilderWorkflow } from '../types';

/** Wrap nodes in a minimal `BuilderWorkflow`. */
export function wf(nodes: BuilderNode[]): BuilderWorkflow {
  return { name: 'w', description: 'd', meta: {}, nodes };
}

/** A minimal prompt node with optional dependencies. */
export function promptNode(id: string, dependsOn?: string[]): BuilderNode {
  return {
    id,
    variant: 'prompt',
    base: dependsOn ? { depends_on: dependsOn } : {},
    data: { prompt: 'x' },
  };
}
