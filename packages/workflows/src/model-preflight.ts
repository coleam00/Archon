/**
 * Collect provider/model paths from a workflow and run OMP preflight checks.
 *
 * Default mode is a cheap registry/credential resolution check (no LLM prompt).
 * Pass `{ live: true }` to run real prompt probes instead (slow, token-costed,
 * network-dependent) — gated behind `archon validate workflows --live`.
 */
import type { WorkflowDefinition, DagNode } from './schemas';
import type { ValidationIssue } from './validator';

/** Options for validateOmpModelLiveness. */
export interface OmpModelPreflightOptions {
  /** When true, send a real prompt probe per model instead of the cheap registry check. */
  live?: boolean;
}

function resolveNodeModelPath(
  node: DagNode,
  workflow: WorkflowDefinition,
  defaultProvider?: string
): string | undefined {
  if (node.model) return node.model;
  const provider = node.provider ?? workflow.provider ?? defaultProvider;
  if (provider === 'omp' && workflow.model) return workflow.model;
  if (provider === 'omp' && node.on_failure_model) return node.on_failure_model;
  return undefined;
}

export function collectOmpModelPaths(
  workflow: WorkflowDefinition,
  defaultProvider?: string
): string[] {
  const paths = new Set<string>();
  const wfProvider = workflow.provider ?? defaultProvider;
  if (wfProvider === 'omp' && workflow.model) paths.add(workflow.model);
  // Workflow-level on_failure_model: any OMP node without a per-node pin
  // inherits this — surface it for preflight so missing credentials block
  // the run BEFORE the first node reaches the breaker.
  if (wfProvider === 'omp' && workflow.on_failure_model) {
    paths.add(workflow.on_failure_model);
  }
  for (const node of workflow.nodes) {
    const provider = node.provider ?? wfProvider;
    if (provider !== 'omp') continue;
    const primary = resolveNodeModelPath(node, workflow, defaultProvider);
    if (primary) paths.add(primary);
    if ('on_failure_model' in node && typeof node.on_failure_model === 'string') {
      paths.add(node.on_failure_model);
    }
  }
  return [...paths];
}

export async function validateOmpModelLiveness(
  workflow: WorkflowDefinition,
  cwd: string,
  defaultProvider?: string,
  env?: Record<string, string>,
  options?: OmpModelPreflightOptions
): Promise<ValidationIssue[]> {
  const paths = collectOmpModelPaths(workflow, defaultProvider);
  if (paths.length === 0) return [];
  // Lazy import: keeps @archon/workflows off the OMP provider implementation
  // unless a workflow actually references an OMP model (contract-layer-only
  // dependency boundary — see CLAUDE.md package split).
  const { checkModelResolutionAll } =
    await import('@archon/providers/community/omp/model-preflight');
  const results = await checkModelResolutionAll(paths, cwd, env, { live: options?.live === true });
  const issues: ValidationIssue[] = [];
  for (const r of results) {
    if (r.ok) continue;
    issues.push({
      level: 'error',
      field: 'model',
      message: `Model unreachable via omp: ${r.modelPath} — ${r.error ?? 'probe failed'}`,
      hint: 'Run `archon doctor` or `omp "OK" --model <path> --print` to debug credentials and routing.',
    });
  }
  return issues;
}
