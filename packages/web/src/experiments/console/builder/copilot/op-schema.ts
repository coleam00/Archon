/**
 * The Builder Copilot's Proposed Edit op vocabulary — the single client-side
 * source of truth `translate-ops.ts` maps onto the `EditorAction` union.
 *
 * `@archon/core`'s `propose-workflow-edits-tool.ts` hand-duplicates the same
 * five op shapes and validation rules (a web package cannot be imported from
 * `@archon/core`) — the two are kept intentionally textually identical; a
 * change here should be mirrored there.
 */
import { isVariantId, VARIANT_REGISTRY } from '../variants';
import { NODE_ID_PATTERN } from '../editor/state';
import type { VariantId } from '../types';

export type ProposedEdit =
  | { op: 'addNode'; id: string; variant: VariantId; data?: Record<string, unknown> }
  | { op: 'connect'; source: string; target: string }
  | { op: 'setField'; id: string; path: string; value: unknown }
  | { op: 'rename'; id: string; nextId: string }
  | { op: 'remove'; id: string };

const KNOWN_OPS: ReadonlySet<string> = new Set([
  'addNode',
  'connect',
  'setField',
  'rename',
  'remove',
]);

function validateOp(raw: unknown): { ok: true; op: ProposedEdit } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'each op must be an object' };
  }
  const r = raw as Record<string, unknown>;
  const kind = typeof r.op === 'string' ? r.op : '';
  if (!KNOWN_OPS.has(kind)) {
    return {
      ok: false,
      error: `unknown op '${kind}' (expected one of ${[...KNOWN_OPS].join(', ')})`,
    };
  }
  switch (kind) {
    case 'addNode': {
      const id = typeof r.id === 'string' ? r.id : '';
      const variant = typeof r.variant === 'string' ? r.variant : '';
      if (id === '') return { ok: false, error: 'addNode requires id' };
      // Reject here rather than letting the reducer's `add-node` silently fall
      // back to a synthesized `<variant>-N` id: the translator would keep the
      // REQUESTED id in `knownIds`, so later ops in the same batch would
      // reference a node that was never created — a silent mis-apply with no
      // issue raised and Accept still enabled.
      if (!NODE_ID_PATTERN.test(id)) {
        return { ok: false, error: `addNode: id '${id}' must match ${NODE_ID_PATTERN.source}` };
      }
      if (!isVariantId(variant)) {
        return { ok: false, error: `addNode: unknown variant '${variant}'` };
      }
      const data =
        typeof r.data === 'object' && r.data !== null
          ? (r.data as Record<string, unknown>)
          : undefined;
      // Reject unknown `data` keys instead of letting `translate-ops` merge them
      // over the variant defaults, which leaves the real field empty and surfaces
      // as an unexplained "must not be empty" on the preview. Derived from the
      // registry, so unlike the server-side mirror this cannot drift.
      //
      // `dataKeys`, NOT `Object.keys(defaultData())` — the latter covers only the
      // initialized fields and would reject legitimate optional ones (bash
      // `timeout`, script `deps`, approval `capture_response`, …).
      if (data !== undefined) {
        const allowed: readonly string[] = VARIANT_REGISTRY[variant].dataKeys;
        const unknown = Object.keys(data).filter(k => !allowed.includes(k));
        if (unknown.length > 0) {
          return {
            ok: false,
            error:
              `addNode '${id}': ${variant} data does not accept ` +
              `${unknown.map(k => `'${k}'`).join(', ')}. ` +
              `Use a flat object with only: ${allowed.join(', ')}.`,
          };
        }
      }
      return { ok: true, op: { op: 'addNode', id, variant, data } };
    }
    case 'connect': {
      const source = typeof r.source === 'string' ? r.source : '';
      const target = typeof r.target === 'string' ? r.target : '';
      if (source === '' || target === '') {
        return { ok: false, error: 'connect requires source and target' };
      }
      return { ok: true, op: { op: 'connect', source, target } };
    }
    case 'setField': {
      const id = typeof r.id === 'string' ? r.id : '';
      const path = typeof r.path === 'string' ? r.path : '';
      if (id === '' || path === '') {
        return { ok: false, error: 'setField requires id and path' };
      }
      if (!path.startsWith('data.') && !path.startsWith('base.')) {
        return {
          ok: false,
          error: `setField: path must start with 'data.' or 'base.' (got '${path}')`,
        };
      }
      return { ok: true, op: { op: 'setField', id, path, value: r.value } };
    }
    case 'rename': {
      const id = typeof r.id === 'string' ? r.id : '';
      const nextId = typeof r.nextId === 'string' ? r.nextId : '';
      if (id === '' || nextId === '') {
        return { ok: false, error: 'rename requires id and nextId' };
      }
      // `rename-node` has no synthesize-a-fallback branch, but an invalid target
      // id would still produce a node the DAG loader later rejects — fail here.
      if (!NODE_ID_PATTERN.test(nextId)) {
        return {
          ok: false,
          error: `rename: nextId '${nextId}' must match ${NODE_ID_PATTERN.source}`,
        };
      }
      return { ok: true, op: { op: 'rename', id, nextId } };
    }
    case 'remove': {
      const id = typeof r.id === 'string' ? r.id : '';
      if (id === '') return { ok: false, error: 'remove requires id' };
      return { ok: true, op: { op: 'remove', id } };
    }
    default:
      // Unreachable — kind is narrowed to a KNOWN_OPS member above.
      return { ok: false, error: `unknown op '${kind}'` };
  }
}

/** Parse + validate a `propose_workflow_edits` tool call's `ops` JSON string. Never throws. */
export function parseAndValidateOps(
  json: string
): { ok: true; ops: ProposedEdit[] } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e: unknown) {
    return { ok: false, error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: 'ops must be a JSON array' };
  if (parsed.length === 0) return { ok: false, error: 'ops must be a non-empty array' };

  const ops: ProposedEdit[] = [];
  for (const [i, raw] of parsed.entries()) {
    const result = validateOp(raw);
    if (!result.ok) return { ok: false, error: `op[${i.toString()}]: ${result.error}` };
    ops.push(result.op);
  }
  return { ok: true, ops };
}
