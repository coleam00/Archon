/**
 * Pure function that converts an n8n workflow JSON export to an Archon WorkflowDefinition.
 *
 * Design: no I/O, no side effects. Unknown n8n node types become bash stubs with a TODO
 * comment and add an entry to ConversionResult.warnings.
 *
 * n8n JSON shape (relevant fields):
 *   name: string
 *   nodes: Array<{ id, name, type, parameters }>
 *   connections: Record<sourceNodeName, { main: Array<Array<{ node, type, index }>> }>
 */
import type { WorkflowDefinition } from './schemas/workflow';
import type { DagNode } from './schemas/dag-node';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ConversionResult {
  workflow: WorkflowDefinition;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// n8n JSON shape — minimal subset we consume
// ---------------------------------------------------------------------------

interface N8nNode {
  id: string;
  name: string;
  type: string;
  parameters?: Record<string, unknown>;
}

interface N8nConnectionTarget {
  node: string;
  type: string;
  index: number;
}

interface N8nWorkflow {
  name: string;
  nodes: N8nNode[];
  connections?: Record<string, { main?: N8nConnectionTarget[][] }>;
}

// ---------------------------------------------------------------------------
// Internal partial-node shape used before id/depends_on are attached
// ---------------------------------------------------------------------------

type NodeKernel =
  | { bash: string }
  | { prompt: string }
  | { script: string; runtime: 'bun' | 'uv' }
  | { approval: { message: string } };

type NodeMapper = (node: N8nNode) => NodeKernel;

// ---------------------------------------------------------------------------
// Node type mapping table — extend here to support new n8n node types
// ---------------------------------------------------------------------------

const NODE_TYPE_MAP: Map<string, NodeMapper> = new Map([
  [
    'n8n-nodes-base.OpenAiChat',
    (node): NodeKernel => ({
      prompt:
        (node.parameters?.prompt as string | undefined) ??
        '# TODO: fill in prompt for OpenAiChat node',
    }),
  ],
  [
    'n8n-nodes-base.Code',
    (node): NodeKernel => {
      const code =
        (node.parameters?.jsCode as string | undefined) ??
        (node.parameters?.pythonCode as string | undefined) ??
        '# TODO: add code';
      const isPython = node.parameters?.language === 'python';
      if (isPython) {
        return {
          script: `# Converted from n8n Code node\n${code}`,
          runtime: 'uv',
        };
      }
      return { bash: `# Converted from n8n Code node\n${code}` };
    },
  ],
  [
    'n8n-nodes-base.HttpRequest',
    (node): NodeKernel => {
      const url = (node.parameters?.url as string | undefined) ?? 'https://example.com';
      const method = (node.parameters?.method as string | undefined) ?? 'GET';
      return {
        bash: `# Converted from n8n HttpRequest node\ncurl -s -X ${method.toUpperCase()} '${url}'`,
      };
    },
  ],
  [
    'n8n-nodes-base.Wait',
    (_node): NodeKernel => ({
      approval: {
        message: 'Workflow paused (converted from n8n Wait node). Approve to continue.',
      },
    }),
  ],
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toKebabCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function toNodeId(name: string): string {
  return toKebabCase(name) || 'node';
}

function stubKernel(n8nType: string): NodeKernel {
  return {
    bash: `# TODO: map from n8n type ${n8nType}\necho "Unsupported n8n node type: ${n8nType}"`,
  };
}

// ---------------------------------------------------------------------------
// Main converter
// ---------------------------------------------------------------------------

/**
 * Convert an n8n workflow JSON export to an Archon WorkflowDefinition.
 * Never throws — unknown node types produce bash stubs + warnings.
 */
export function convertN8nToArchon(n8nJson: unknown): ConversionResult {
  const warnings: string[] = [];

  if (typeof n8nJson !== 'object' || n8nJson === null || Array.isArray(n8nJson)) {
    warnings.push('Input is not a valid n8n workflow object. Generating empty workflow.');
    return {
      workflow: { name: 'imported-workflow', description: 'Imported from n8n', nodes: [] },
      warnings,
    };
  }

  const raw = n8nJson as Record<string, unknown>;
  const n8nWorkflow: N8nWorkflow = {
    name: typeof raw.name === 'string' ? raw.name : 'imported-workflow',
    nodes: Array.isArray(raw.nodes) ? (raw.nodes as N8nNode[]) : [],
    connections:
      typeof raw.connections === 'object' && raw.connections !== null
        ? (raw.connections as N8nWorkflow['connections'])
        : {},
  };

  // Assign deterministic Archon IDs keyed by n8n UUID, deduplicating name collisions.
  // n8n connections reference nodes by *name*, so we also maintain a name→firstId map
  // for connection resolution (name collisions in connections are unresolvable; we use
  // first-seen, which is the same heuristic n8n itself applies).
  const uuidToId = new Map<string, string>();
  const nameToFirstId = new Map<string, string>();
  const idCount = new Map<string, number>();
  for (const n8nNode of n8nWorkflow.nodes) {
    const base = toNodeId(n8nNode.name);
    const count = idCount.get(base) ?? 0;
    idCount.set(base, count + 1);
    const archonId = count === 0 ? base : `${base}-${count}`;
    uuidToId.set(n8nNode.id, archonId);
    if (!nameToFirstId.has(n8nNode.name)) {
      nameToFirstId.set(n8nNode.name, archonId);
    }
  }

  // Build depends_on from n8n connections
  // connections[sourceName].main[outputIndex] = [{ node: targetName, ... }]
  const dependsOnMap = new Map<string, string[]>();
  const connections = n8nWorkflow.connections ?? {};
  for (const [sourceName, conns] of Object.entries(connections)) {
    const sourceId = nameToFirstId.get(sourceName);
    if (!sourceId) continue;
    for (const outputTargets of conns.main ?? []) {
      for (const target of outputTargets ?? []) {
        const targetId = nameToFirstId.get(target.node);
        if (!targetId) continue;
        const deps = dependsOnMap.get(targetId) ?? [];
        if (!deps.includes(sourceId)) deps.push(sourceId);
        dependsOnMap.set(targetId, deps);
      }
    }
  }

  const nodes: DagNode[] = [];

  for (const n8nNode of n8nWorkflow.nodes) {
    const id = uuidToId.get(n8nNode.id) ?? toNodeId(n8nNode.name);
    const mapper = NODE_TYPE_MAP.get(n8nNode.type);

    if (!mapper) {
      warnings.push(
        `Unknown n8n node type "${n8nNode.type}" (node: "${n8nNode.name}") — converted to bash stub`
      );
    }

    const kernel = mapper ? mapper(n8nNode) : stubKernel(n8nNode.type);
    const dependsOn = dependsOnMap.get(id);
    const deps = dependsOn && dependsOn.length > 0 ? { depends_on: dependsOn } : {};

    // Safe cast: kernel contains exactly one of the DagNode discriminant fields (bash/prompt/
    // script+runtime/approval), and all non-listed fields are absent (satisfies the `?:never` side).
    nodes.push({ id, ...deps, ...kernel } as DagNode);
  }

  const workflowName = toKebabCase(n8nWorkflow.name) || 'imported-workflow';

  return {
    workflow: {
      name: workflowName,
      description: `Imported from n8n workflow: ${n8nWorkflow.name}`,
      nodes,
    },
    warnings,
  };
}
