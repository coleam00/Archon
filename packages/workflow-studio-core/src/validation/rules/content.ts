import type { DagNode } from '../../schemas';
import { parse } from '../../lib/grammar';
import { transitiveUpstream } from '../../components/when/transitiveUpstream';
import { type Issue } from '../types';
import { mk } from './helpers';

/** Debounced-tier content rules:
 *   - content.when.parse   -- invalid `when:` expression (error)
 *   - content.var.unknown  -- {{ids.X.Y}} references a non-upstream node (warning)
 */
export function runContentRules(nodes: readonly DagNode[]): Issue[] {
  // Build the adapter array once; transitiveUpstream expects NodeLike with
  // base.depends_on, but DagNode has flat depends_on. See drift note 6.3.2.
  const adapted = nodes.map(n => ({ id: n.id, base: { depends_on: n.depends_on } }));

  const out: Issue[] = [];
  for (const node of nodes) {
    out.push(...whenRules(node));
    out.push(...varScanRules(node, adapted));
  }
  return out;
}

// ---------------------------------------------------------------------------
// when: parse check
// ---------------------------------------------------------------------------

function whenRules(node: DagNode): Issue[] {
  // `when` is a flat optional field on every DagNode variant. See drift 6.3.1.
  const when = (node as unknown as Record<string, unknown>).when;
  if (!when || typeof when !== 'string' || when.trim() === '') return [];
  const r = parse(when);
  if (r.ok) return [];
  return [
    mk(
      'content.when.parse',
      'error',
      'client-debounced',
      { nodeId: node.id, field: 'when' },
      `Invalid when: ${r.error}`
    ),
  ];
}

// ---------------------------------------------------------------------------
// {{var}} scan
// ---------------------------------------------------------------------------

/**
 * Strip fenced and inline code spans so example snippets do not trip the scan.
 *
 * Two-pass ordering matters: fenced blocks (```...```) are removed FIRST so
 * that backticks inside fenced regions don't get reinterpreted by the inline
 * (`...`) pass. An unclosed fence falls through to the inline pass — a benign
 * artifact, since an unclosed fence in real content is itself malformed.
 *
 * Tilde fences (~~~) are NOT handled; if Archon docs/usage ever adopts them,
 * extend the first pass.
 */
function stripFences(s: string): string {
  return s.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

// Matches {{ids.<identifier>.<rest>}} — captures the referenced node id.
// The accessor segment uses [^{}]+ (not [^}]+) to reject stray `{` inside the
// ref path — slightly stricter, behaviorally near-identical for valid input.
const VAR_PATTERN = /\{\{\s*ids\.([A-Za-z_][\w-]*)\.[^{}]+\}\}/g;

/**
 * Returns the templated user-content body text for a node.
 *
 * Only fields that are actual user-authored template bodies are included.
 * Condition strings (when, loop.until), non-text config fields, and free-form
 * prose strings (cancel reason) are excluded. See drift note 6.3.3.
 *
 * Included flat fields:   prompt, command, bash, script
 * Included nested fields: approval.message, loop.prompt
 * Excluded:               when, loop.until, loop.max_iterations, cancel
 *
 * MAINTAINERS: When a new DagNode variant lands with a templated user-content
 * field, add it to the list below AND update drift note 6.3.3 with the
 * inclusion rationale. Under-scanning is preferred to over-warning, so add new
 * fields only when there's evidence the Archon executor interpolates them.
 */
function bodyText(node: DagNode): string {
  const n = node as unknown as Record<string, unknown>;
  const parts: string[] = [];

  // Flat string fields
  for (const field of ['prompt', 'command', 'bash', 'script'] as const) {
    const v = n[field];
    if (typeof v === 'string') parts.push(v);
  }

  // Nested: approval.message
  if (n.approval && typeof n.approval === 'object') {
    const ap = n.approval as Record<string, unknown>;
    if (typeof ap.message === 'string') parts.push(ap.message);
  }

  // Nested: loop.prompt (NOT loop.until -- that's a condition expression, not a template)
  if (n.loop && typeof n.loop === 'object') {
    const lc = n.loop as Record<string, unknown>;
    if (typeof lc.prompt === 'string') parts.push(lc.prompt);
  }

  return parts.join('\n');
}

interface AdaptedNode {
  id: string;
  base?: { depends_on?: string[] };
}

function varScanRules(node: DagNode, adapted: AdaptedNode[]): Issue[] {
  const text = stripFences(bodyText(node));
  if (!text.includes('{{')) return [];

  const upstream = new Set(transitiveUpstream(node.id, adapted));
  const issues: Issue[] = [];

  const re = new RegExp(VAR_PATTERN.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const refId = match[1];
    if (!upstream.has(refId)) {
      issues.push(
        mk(
          'content.var.unknown',
          'warning',
          'client-debounced',
          { nodeId: node.id },
          `Template references "${refId}" via {{ids.${refId}...}} but "${refId}" is not an upstream node.`
        )
      );
    }
  }

  return issues;
}
