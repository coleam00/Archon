/**
 * Pure Proposed-Edit → `EditorAction` translator (Pre-flight #4). Maps the
 * copilot's op vocabulary 1:1 onto the console builder's `editorReducer`
 * actions. Never mutates `workflow` — callers fold the returned actions
 * through `editorReducer` themselves, either over a CLONE (preview) or the
 * live reducer (Accept, via the `batch` action).
 */
import { VARIANT_REGISTRY } from '../variants';
import type { BuilderNode, BuilderWorkflow, Issue } from '../types';
import type { EditorAction } from '../editor/state';
import type { XYPosition } from '../flow/types';
import { makeIssue } from '../validation/make-issue';
import type { ProposedEdit } from './op-schema';

function issue(rule: string, message: string, nodeId: string): Issue {
  return makeIssue({
    rule,
    severity: 'error',
    source: 'client-instant',
    message,
    path: { nodeId },
  });
}

/** Mirrors `BuilderPage`'s palette-click stagger so a batch of new nodes doesn't stack at one point. */
function staggeredPosition(index: number): XYPosition {
  return { x: 60 + (index % 5) * 36, y: 60 + index * 28 };
}

/** Set a dotted field path (`"data.<key>"` | `"base.<key>"`) on a cloned `BuilderNode`. */
function patchField(node: BuilderNode, path: string, value: unknown): BuilderNode {
  const dot = path.indexOf('.');
  const section = path.slice(0, dot);
  const key = path.slice(dot + 1);
  if (section === 'data') {
    return { ...node, data: { ...node.data, [key]: value } } as BuilderNode;
  }
  return { ...node, base: { ...node.base, [key]: value } } as BuilderNode;
}

/**
 * Translate a Proposal's ops into the `EditorAction`s that would apply it.
 * Ops referencing an unknown node, a name collision, or a malformed path are
 * dropped and surfaced as an `Issue` instead of throwing — an invalid op in a
 * batch never corrupts the ones around it; the caller decides whether any
 * issues should block Accept.
 */
export function opsToEditorActions(
  ops: readonly ProposedEdit[],
  workflow: BuilderWorkflow
): { actions: EditorAction[]; issues: Issue[] } {
  const actions: EditorAction[] = [];
  const issues: Issue[] = [];
  // The workflow AS THE BATCH WOULD LEAVE IT, rebuilt op by op. Resolving
  // `setField` against the original `workflow` instead was two bugs at once:
  // a second `setField` on one node rebuilt its patch from the stale original
  // and silently reverted the first (patch-node is a whole-node REPLACE, not a
  // merge), and `rename` then `setField` on the new id failed with a misleading
  // "Unknown node" because the original still held the old id. Keying this map
  // by CURRENT id makes both correct and makes `knownIds` redundant.
  const working = new Map<string, BuilderNode>(workflow.nodes.map(n => [n.id, n]));
  let addedCount = 0;

  for (const op of ops) {
    switch (op.op) {
      case 'addNode': {
        if (working.has(op.id)) {
          issues.push(issue('copilot.addNode.duplicate', `Node '${op.id}' already exists.`, op.id));
          break;
        }
        actions.push({
          type: 'add-node',
          id: op.id,
          variant: op.variant,
          position: staggeredPosition(workflow.nodes.length + addedCount),
          at: 0,
        });
        // Merge proposed fields over the variant's defaults so a partial addNode
        // (e.g. only `message` for an approval node) still produces a fully-shaped
        // node. Recorded in `working` either way, so a later op in the same batch
        // resolves against the node this one will create.
        const merged = {
          id: op.id,
          variant: op.variant,
          base: {},
          data: { ...VARIANT_REGISTRY[op.variant].defaultData(), ...(op.data ?? {}) },
        } as BuilderNode;
        if (op.data !== undefined && Object.keys(op.data).length > 0) {
          actions.push({ type: 'patch-node', node: merged, at: 0 });
        }
        working.set(op.id, merged);
        addedCount += 1;
        break;
      }

      case 'connect': {
        if (!working.has(op.source)) {
          issues.push(
            issue('copilot.connect.unknownSource', `Unknown node '${op.source}'.`, op.source)
          );
          break;
        }
        if (!working.has(op.target)) {
          issues.push(
            issue('copilot.connect.unknownTarget', `Unknown node '${op.target}'.`, op.target)
          );
          break;
        }
        actions.push({ type: 'add-edge', source: op.source, target: op.target, at: 0 });
        break;
      }

      case 'setField': {
        // One lookup, against the batch-local state — so this resolves a node an
        // earlier op renamed or added, and composes with an earlier setField on
        // the same node instead of rebuilding from the stale original.
        const existing = working.get(op.id);
        if (existing === undefined) {
          issues.push(issue('copilot.setField.unknownNode', `Unknown node '${op.id}'.`, op.id));
          break;
        }
        const dot = op.path.indexOf('.');
        if (dot === op.path.length - 1) {
          issues.push(issue('copilot.setField.badPath', `Malformed path '${op.path}'.`, op.id));
          break;
        }
        const patched = patchField(existing, op.path, op.value);
        actions.push({ type: 'patch-node', node: patched, at: 0 });
        working.set(op.id, patched);
        break;
      }

      case 'rename': {
        const node = working.get(op.id);
        if (node === undefined) {
          issues.push(issue('copilot.rename.unknownNode', `Unknown node '${op.id}'.`, op.id));
          break;
        }
        if (working.has(op.nextId)) {
          issues.push(
            issue('copilot.rename.collision', `A node named '${op.nextId}' already exists.`, op.id)
          );
          break;
        }
        actions.push({ type: 'rename-node', id: op.id, nextId: op.nextId, at: 0 });
        // Re-key under the new id AND carry the node's own `id` across, so a
        // later setField patches a node that agrees with itself.
        working.delete(op.id);
        working.set(op.nextId, { ...node, id: op.nextId } as BuilderNode);
        break;
      }

      case 'remove': {
        if (!working.has(op.id)) {
          issues.push(issue('copilot.remove.unknownNode', `Unknown node '${op.id}'.`, op.id));
          break;
        }
        actions.push({ type: 'remove-nodes', ids: [op.id], at: 0 });
        working.delete(op.id);
        break;
      }
    }
  }

  return { actions, issues };
}
