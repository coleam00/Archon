/**
 * Versioned copy/cut/paste envelope. Ported from the standalone studio's
 * `clipboard.ts` and typed against PR-1's `BuilderNode`.
 *
 * Copy serializes the selected nodes with their `depends_on` filtered to
 * *internal* edges (deps inside the selection), so the envelope is
 * self-contained. Paste remaps colliding ids, rewires internal deps through
 * the remap, and offsets positions. External deps are dropped at copy time —
 * a pasted fragment never points back at nodes that may not exist in the
 * target. Pure functions; the envelope lives in editor state (in-memory only —
 * the `version` field exists so a future system-clipboard integration can
 * recognize its own payloads, but no JSON codec ships until one is needed).
 */
import type { BuilderNode, BuilderWorkflow } from '../types';
import type { XYPosition } from '../flow/types';

export const CLIPBOARD_VERSION = 'archon-builder-v1';

export interface ClipboardEnvelope {
  version: typeof CLIPBOARD_VERSION;
  nodes: BuilderNode[];
  /** Canvas positions of the copied nodes, keyed by (pre-remap) node id. */
  positions: Record<string, XYPosition>;
}

/** How far a pasted fragment is offset from the copied original. */
export const PASTE_OFFSET = 24;

/**
 * Build an envelope from the selected node ids. Returns `null` when the
 * selection contains no copyable nodes.
 */
export function copySelection(
  workflow: BuilderWorkflow,
  selection: ReadonlySet<string>,
  positions: ReadonlyMap<string, XYPosition>
): ClipboardEnvelope | null {
  const selected = workflow.nodes.filter(n => selection.has(n.id));
  if (selected.length === 0) return null;
  const internal = new Set(selected.map(n => n.id));

  const nodes = selected.map(node => {
    const deps = (node.base.depends_on ?? []).filter(dep => internal.has(dep));
    return {
      ...node,
      base: { ...node.base, depends_on: deps.length > 0 ? deps : undefined },
    };
  });

  const copiedPositions: Record<string, XYPosition> = {};
  for (const node of selected) {
    const pos = positions.get(node.id);
    if (pos !== undefined) copiedPositions[node.id] = pos;
  }

  return { version: CLIPBOARD_VERSION, nodes, positions: copiedPositions };
}

/** `id` if free, else `id-copy`, `id-copy-2`, … */
function remapId(id: string, taken: ReadonlySet<string>): string {
  if (!taken.has(id)) return id;
  let candidate = `${id}-copy`;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${id}-copy-${n}`;
    n += 1;
  }
  return candidate;
}

/**
 * Materialize an envelope into the target workflow: remap colliding ids,
 * rewire internal `depends_on` through the remap, offset positions. Returns
 * the new nodes plus their positions (keyed by post-remap id).
 */
export function pasteEnvelope(
  envelope: ClipboardEnvelope,
  existingIds: ReadonlySet<string>,
  offset: XYPosition = { x: PASTE_OFFSET, y: PASTE_OFFSET }
): { nodes: BuilderNode[]; positions: Map<string, XYPosition> } {
  const taken = new Set(existingIds);
  const remap = new Map<string, string>();
  for (const node of envelope.nodes) {
    const next = remapId(node.id, taken);
    remap.set(node.id, next);
    taken.add(next);
  }

  const nodes = envelope.nodes.map(node => {
    const deps = (node.base.depends_on ?? []).map(dep => remap.get(dep) ?? dep);
    return {
      ...node,
      id: remap.get(node.id) ?? node.id,
      base: { ...node.base, depends_on: deps.length > 0 ? deps : undefined },
    };
  });

  const positions = new Map<string, XYPosition>();
  for (const [oldId, pos] of Object.entries(envelope.positions)) {
    const next = remap.get(oldId);
    if (next === undefined) continue;
    positions.set(next, { x: pos.x + offset.x, y: pos.y + offset.y });
  }

  return { nodes, positions };
}
