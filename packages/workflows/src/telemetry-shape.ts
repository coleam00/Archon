import {
  createLogger,
  isTelemetryDisabled,
  type PromptCharsBucket,
  type WorkflowAncestryProperties,
  type WorkflowInvokedProperties,
  type WorkflowNodeType,
  type WorkflowShapeProperties,
  type WorkflowTelemetrySource,
} from '@archon/paths';
import { basename } from 'node:path';
import {
  BUNDLED_COMMANDS,
  BUNDLED_WORKFLOWS,
  BUNDLED_WORKFLOW_OWNERS,
  BUNDLED_WORKFLOW_PATHS,
} from './defaults/bundled-defaults';
import { expandWorkflowIncludes } from './include-expander';
import { parseWorkflow } from './loader';
import { qualifyWorkflowResources } from './packaged-workflow';
import type { DagNode } from './schemas/dag-node';
import type { ResolvedWorkflow, WorkflowDefinition } from './schemas/workflow';
import { telemetryNodeType } from './telemetry-node-type';

/** Every node, loop_group bodies included, with its path-qualified id. */
function flattenNodes(nodes: readonly DagNode[], prefix = ''): { path: string; node: DagNode }[] {
  return nodes.flatMap(node => {
    const path = prefix + node.id;
    const body =
      node.kind === 'loop_group'
        ? flattenNodes(node.loop_group.nodes as readonly DagNode[], `${path}/`)
        : [];
    return [{ path, node }, ...body];
  });
}

function commandOf(node: DagNode): string | undefined {
  if (node.kind === 'agent' && node.source.kind === 'command') return node.source.name;
  if (node.kind === 'loop') return node.loop.command;
  return undefined;
}

function inlinePromptOf(node: DagNode): string | undefined {
  if (node.kind === 'agent' && node.source.kind === 'inline') return node.source.prompt;
  if (node.kind === 'loop') return node.loop.prompt;
  return undefined;
}

export function promptCharsBucket(chars: number): PromptCharsBucket {
  if (chars === 0) return 'none';
  if (chars < 1_000) return 'lt_1k';
  if (chars < 5_000) return '1k_5k';
  if (chars < 20_000) return '5k_20k';
  return 'gte_20k';
}

export function describeWorkflowShape(workflow: ResolvedWorkflow): WorkflowShapeProperties {
  const all = flattenNodes(workflow.nodes);
  const nodeCounts: Partial<Record<WorkflowNodeType, number>> = {};
  const commands = new Set<string>();
  let promptChars = 0;
  for (const { node } of all) {
    const type = telemetryNodeType(node);
    nodeCounts[type] = (nodeCounts[type] ?? 0) + 1;
    const command = commandOf(node);
    if (command !== undefined) commands.add(command);
    promptChars += inlinePromptOf(node)?.length ?? 0;
  }
  const dependents = new Map<string, number>();
  for (const node of workflow.nodes)
    for (const dep of node.depends_on ?? []) dependents.set(dep, (dependents.get(dep) ?? 0) + 1);
  return {
    nodeCounts,
    graphDepth: workflow.plan.layers.length,
    maxFanOut: Math.max(0, ...dependents.values()),
    commandRefs: commands.size,
    promptCharsBucket: promptCharsBucket(promptChars),
  };
}

/**
 * Structural signature compared in memory only; it never leaves this module. Two
 * workflows with equal signatures have the same graph and the same node bodies.
 */
function signatureOf(workflow: Pick<ResolvedWorkflow, 'nodes'>): string[] {
  return flattenNodes(workflow.nodes).map(({ path, node }) =>
    JSON.stringify([
      path,
      telemetryNodeType(node),
      [...(node.depends_on ?? [])].sort(),
      commandOf(node) ?? inlinePromptOf(node) ?? (node.kind === 'exec' ? node.script : null),
    ])
  );
}

interface BundledSignature {
  name: string;
  ids: ReadonlySet<string>;
  signature: readonly string[];
}

let bundledSignatures: readonly BundledSignature[] | undefined;

/**
 * The bundled workflows, prepared the way discovery prepares them (parsed, pack-owned
 * resources qualified, includes expanded against the embedded command bodies) so a
 * project copy and its original compare in one form. Built once per process, in memory.
 * A bundled workflow that fails to parse or expand is left out rather than failing.
 */
function getBundledSignatures(): readonly BundledSignature[] {
  if (bundledSignatures) return bundledSignatures;
  const rawByName = new Map<string, WorkflowDefinition>();
  for (const [key, content] of Object.entries(BUNDLED_WORKFLOWS)) {
    const path = BUNDLED_WORKFLOW_PATHS[key];
    const { workflow } = parseWorkflow(content, path ? basename(path) : `${key}.yaml`);
    if (!workflow || rawByName.has(workflow.name)) continue;
    const owner = BUNDLED_WORKFLOW_OWNERS[key];
    if (owner) qualifyWorkflowResources(workflow, { source: 'bundled', ...owner });
    rawByName.set(workflow.name, workflow);
  }
  const { workflows } = expandWorkflowIncludes(
    rawByName,
    new Map(Object.entries(BUNDLED_COMMANDS))
  );
  bundledSignatures = [...workflows.values()].map(workflow => ({
    name: workflow.name,
    ids: new Set(flattenNodes(workflow.nodes).map(entry => entry.path)),
    signature: signatureOf(workflow),
  }));
  return bundledSignatures;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let shared = 0;
  for (const id of a) if (b.has(id)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** Share of node ids a copy must keep with its bundled original to count as `modified`. */
const MODIFIED_MIN_SIMILARITY = 0.5;

/**
 * Which bundled workflow a non-bundled workflow was copied from, if any. The candidate
 * is the bundled workflow with the same name, else the one sharing the most node ids.
 * Only the bundled name and the similarity class are returned.
 */
export function deriveBundledAncestry(
  workflow: ResolvedWorkflow
): WorkflowAncestryProperties | undefined {
  const bundled = getBundledSignatures();
  const ids = new Set(flattenNodes(workflow.nodes).map(entry => entry.path));
  let candidate = bundled.find(entry => entry.name === workflow.name);
  let similarity = candidate ? jaccard(ids, candidate.ids) : 0;
  if (!candidate) {
    for (const entry of bundled) {
      const score = jaccard(ids, entry.ids);
      if (score > similarity) [candidate, similarity] = [entry, score];
    }
  }
  if (!candidate) return undefined;
  const signature = signatureOf(workflow);
  if (
    signature.length === candidate.signature.length &&
    signature.every((part, index) => part === candidate.signature[index])
  )
    return { derivedFrom: candidate.name, derivedSimilarity: 'identical' };
  if (similarity >= MODIFIED_MIN_SIMILARITY)
    return { derivedFrom: candidate.name, derivedSimilarity: 'modified' };
  return undefined;
}

/**
 * The shape and bundled ancestry `workflow_invoked` carries. Computed only when telemetry
 * is on, so a disabled install never parses the bundled workflows. Telemetry never fails
 * a run: an error here is logged and the event goes out without these fields.
 */
export function workflowTelemetryShape(
  workflow: ResolvedWorkflow,
  source: WorkflowTelemetrySource | undefined
): Pick<WorkflowInvokedProperties, 'shape' | 'ancestry'> {
  if (isTelemetryDisabled()) return {};
  try {
    const ancestry = source === 'bundled' ? undefined : deriveBundledAncestry(workflow);
    return { shape: describeWorkflowShape(workflow), ...(ancestry ? { ancestry } : {}) };
  } catch (error) {
    createLogger('workflow.telemetry-shape').debug(
      { err: error as Error },
      'telemetry.workflow_shape_failed'
    );
    return {};
  }
}
