/**
 * Collect provider/model paths from a workflow and run OMP preflight probes.
 */
import type { WorkflowDefinition, DagNode } from './schemas';
import { checkModelResolutionAll } from '@archon/providers/community/omp/model-preflight';
import type { ValidationIssue } from './validator';

function resolveNodeModelPath(
  node: DagNode,
  workflow: WorkflowDefinition,
  defaultProvider?: string
): string | undefined {
  if (node.model) return node.model;
  const provider = node.provider ?? workflow.provider ?? defaultProvider;
  if (provider === 'omp' && workflow.model) return workflow.model;
  if (provider === 'omp' && node.fallback) return node.fallback;
  return undefined;
}

export function collectOmpModelPaths(
  workflow: WorkflowDefinition,
  defaultProvider?: string
): string[] {
  const paths = new Set<string>();
  const wfProvider = workflow.provider ?? defaultProvider;
  if (wfProvider === 'omp' && workflow.model) paths.add(workflow.model);
  for (const node of workflow.nodes) {
    const provider = node.provider ?? wfProvider;
    if (provider !== 'omp') continue;
    const primary = resolveNodeModelPath(node, workflow, defaultProvider);
    if (primary) paths.add(primary);
    if ('fallback' in node && typeof node.fallback === 'string') paths.add(node.fallback);
  }
  return [...paths];
}

export async function validateOmpModelLiveness(
  workflow: WorkflowDefinition,
  cwd: string,
  defaultProvider?: string,
  env?: Record<string, string>
): Promise<ValidationIssue[]> {
  const paths = collectOmpModelPaths(workflow, defaultProvider);
  if (paths.length === 0) return [];
  const results = await checkModelResolutionAll(paths, cwd, env);
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
