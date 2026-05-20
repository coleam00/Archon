import type { DagNode } from '../../schemas';
import { type Issue } from '../types';
import { mk as mkIssue } from './helpers';

/** Pure: runs on every render. Cheap. Errors only. */
export function runStructuralRules(nodes: readonly DagNode[]): Issue[] {
  const out: Issue[] = [];
  const seen = new Map<string, number>();

  // First pass: check empty ids and tally for duplicate detection.
  // Skip further checks on empty-id nodes (duplicate detection is meaningless).
  const emptyIdNodes = new Set<DagNode>();
  for (const n of nodes) {
    if (!n.id || n.id.trim() === '') {
      out.push(mk('structural.id.empty', n.id ?? '', undefined, 'Node id is empty.'));
      emptyIdNodes.add(n);
    } else {
      seen.set(n.id, (seen.get(n.id) ?? 0) + 1);
    }
  }

  // Second pass: duplicate ids + per-variant required fields.
  for (const n of nodes) {
    if (emptyIdNodes.has(n)) continue;

    if ((seen.get(n.id) ?? 0) > 1) {
      out.push(mk('structural.id.duplicate', n.id, undefined, `Duplicate node id: "${n.id}".`));
    }

    out.push(...requiredFieldRules(n));
  }

  return out;
}

// ---------------------------------------------------------------------------
// Per-variant required-field checks
//
// DagNode is a discriminated union where each variant is identified by
// possession of a specific field (not a `type` property). We use type guards
// and `'field' in n` checks to dispatch. The fields checked here are the
// discriminating fields themselves — validating them defends against inputs
// that bypassed Zod (e.g., BuilderNode-derived partial objects).
//
// Real DagNode variants:
//   CommandNode  → n.command: string
//   PromptNode   → n.prompt: string
//   BashNode     → n.bash: string
//   ScriptNode   → n.script: string
//   LoopNode     → n.loop: LoopNodeConfig (object)
//   ApprovalNode → n.approval: { message, ... }
//   CancelNode   → n.cancel: string
// ---------------------------------------------------------------------------

function requiredFieldRules(n: DagNode): Issue[] {
  const out: Issue[] = [];
  // Use `in` checks — type guards from dag-node.ts work for bash/loop/approval/cancel/script.
  // For command/prompt we check the field directly.

  if ('command' in n) {
    const cmd = (n as { command?: unknown }).command;
    if (!cmd || typeof cmd !== 'string' || !cmd.trim()) {
      out.push(
        mk(
          'structural.required.command',
          n.id,
          'command',
          'Command node requires a non-empty `command` field.'
        )
      );
    }
    return out;
  }

  if ('prompt' in n && !('loop' in n)) {
    // PromptNode has `prompt`; LoopNode has `loop` (checked below).
    // Guard: avoid matching LoopNode (which also may have prompt inside loop config).
    const p = (n as { prompt?: unknown }).prompt;
    if (!p || typeof p !== 'string' || !p.trim()) {
      out.push(
        mk(
          'structural.required.prompt',
          n.id,
          'prompt',
          'Prompt node requires a non-empty `prompt` field.'
        )
      );
    }
    return out;
  }

  if ('bash' in n) {
    const b = (n as { bash?: unknown }).bash;
    if (!b || typeof b !== 'string' || !b.trim()) {
      out.push(
        mk('structural.required.bash', n.id, 'bash', 'Bash node requires a non-empty `bash` field.')
      );
    }
    return out;
  }

  if ('script' in n) {
    const s = (n as { script?: unknown }).script;
    if (!s || typeof s !== 'string' || !s.trim()) {
      out.push(
        mk(
          'structural.required.script',
          n.id,
          'script',
          'Script node requires a non-empty `script` field.'
        )
      );
    }
    return out;
  }

  if ('loop' in n) {
    const loop = (n as { loop?: unknown }).loop;
    if (!loop || typeof loop !== 'object') {
      out.push(
        mk(
          'structural.required.loop',
          n.id,
          'loop',
          'Loop node requires a `loop` configuration object.'
        )
      );
      return out;
    }
    const lc = loop as Record<string, unknown>;
    if (!lc.prompt || typeof lc.prompt !== 'string' || !lc.prompt.trim()) {
      out.push(
        mk(
          'structural.required.loop.prompt',
          n.id,
          'loop.prompt',
          'Loop node requires `loop.prompt` (non-empty string).'
        )
      );
    }
    if (!lc.until || typeof lc.until !== 'string' || !lc.until.trim()) {
      out.push(
        mk(
          'structural.required.loop.until',
          n.id,
          'loop.until',
          'Loop node requires `loop.until` (non-empty string).'
        )
      );
    }
    if (typeof lc.max_iterations !== 'number' || lc.max_iterations <= 0) {
      out.push(
        mk(
          'structural.required.loop.max_iterations',
          n.id,
          'loop.max_iterations',
          'Loop node requires `loop.max_iterations` (positive integer).'
        )
      );
    }
    return out;
  }

  if ('approval' in n) {
    const approval = (n as { approval?: unknown }).approval;
    if (!approval || typeof approval !== 'object') {
      out.push(
        mk(
          'structural.required.approval',
          n.id,
          'approval',
          'Approval node requires an `approval` object.'
        )
      );
      return out;
    }
    const ap = approval as Record<string, unknown>;
    if (!ap.message || typeof ap.message !== 'string' || !ap.message.trim()) {
      out.push(
        mk(
          'structural.required.approval.message',
          n.id,
          'approval.message',
          "Approval node requires a non-empty 'approval.message'."
        )
      );
    }
    return out;
  }

  if ('cancel' in n) {
    const c = (n as { cancel?: unknown }).cancel;
    if (!c || typeof c !== 'string' || !c.trim()) {
      out.push(
        mk(
          'structural.required.cancel',
          n.id,
          'cancel',
          'Cancel node requires a non-empty `cancel` reason.'
        )
      );
    }
    return out;
  }

  // Unknown variant — no required-field rules to fire.
  return out;
}

function mk(rule: string, nodeId: string, field: string | undefined, message: string): Issue {
  const path = { nodeId, ...(field !== undefined ? { field } : {}) };
  return mkIssue(rule, 'error', 'client-instant', path, message);
}
