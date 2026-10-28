import type { ProviderRegistry } from '@archon/provider-contract';
import type { DagNode, WorkflowDefinition } from '../schemas';
import { isWorkflowNode } from '../schemas';
import { BUNDLED_WORKFLOWS } from '../defaults/bundled-defaults';
import { parseWorkflow } from '../loader';
import { resolveWorkflowName } from '../router';
import type { ResourceValidation } from './context';

/**
 * Bundled workflow definitions admitted by the supplied registry, parsed once per
 * registry and cached (#2470). Used only by the
 * bundled-set-only `workflow:` target check below — a bundled workflow's sub-run target
 * must itself resolve within the bundled set (a bundled workflow can't depend on a
 * project/global workflow that may not exist on another install). Resolution reuses the
 * runtime exact-name resolver.
 * parseWorkflow never expands includes, so `workflow.name` is the authoritative id here.
 */
const bundledWorkflowDefsCache = new WeakMap<ProviderRegistry, WorkflowDefinition[]>();
function getBundledWorkflowDefs(providers: ProviderRegistry): WorkflowDefinition[] {
  const cached = bundledWorkflowDefsCache.get(providers);
  if (cached) return cached;
  const defs: WorkflowDefinition[] = [];
  for (const [filename, content] of Object.entries(BUNDLED_WORKFLOWS)) {
    const { workflow } = parseWorkflow(content, filename, providers);
    if (workflow) defs.push(workflow);
  }
  bundledWorkflowDefsCache.set(providers, defs);
  return defs;
}

/**
 * A BUNDLED workflow ships with the binary and runs on any install, so its sub-run
 * targets must resolve within the bundled set — a reference to a project/global
 * workflow could be absent elsewhere (#2470). Only the bundled set is checked at load/CI;
 * project sub-run targets stay RUNTIME-resolved on purpose (a load-time existence
 * check would silently kill mid-flight authoring — constitution case-law), and the
 * check uses the same exact-name resolver as runtime.
 */
export function validateBundledWorkflowTarget(validation: ResourceValidation, node: DagNode): void {
  if (validation.config?.workflowSource !== 'bundled' || !isWorkflowNode(node)) return;
  const resolvedTarget = resolveWorkflowName(
    node.workflow,
    getBundledWorkflowDefs(validation.providers)
  );
  if (!resolvedTarget) {
    validation.issues.push({
      level: 'error',
      nodeId: node.id,
      field: 'workflow',
      message: `Node '${node.id}' targets sub-run '${node.workflow}', which is not a bundled workflow`,
      hint: 'A bundled workflow may only reference other bundled workflows (project/global targets are not guaranteed to exist on every install).',
    });
  }
}
