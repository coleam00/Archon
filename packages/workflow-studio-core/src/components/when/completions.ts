import {
  type CompletionContext,
  type CompletionResult,
  autocompletion,
} from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';

interface Options {
  /** Upstream node ids this autocomplete will offer after `$`. */
  upstreamIds: readonly string[];
  /**
   * Returns the upstream node's `output_format` (JSON Schema-shaped object)
   * or `null` if unavailable. Used to drive `.output.` field completions.
   */
  outputFormatLookup: (nodeId: string) => Record<string, unknown> | null;
}

/**
 * CodeMirror 6 autocompletion source that fires inside body textareas to
 * suggest `$nodeId.output.field` references. Three completion stages:
 *
 *   `$`              -> upstream node ids
 *   `$<id>.`         -> `output`
 *   `$<id>.output.`  -> keys of upstream node's `output_format.properties`
 *
 * Returns a *function* (not the wrapped Extension) so callers can both
 * compose it into other extensions AND test it directly.
 */
export function whenAutocomplete(opts: Options) {
  return function source(ctx: CompletionContext): CompletionResult | null {
    const before = ctx.state.doc.sliceString(0, ctx.pos);

    // Trailing `.` after a $ref → complete children of last segment.
    const refMatch = /\$([A-Za-z_][A-Za-z0-9_-]*)((?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.$/.exec(before);
    if (refMatch) {
      const nodeId = refMatch[1];
      const path = refMatch[2].slice(1).split('.').filter(Boolean);
      return completeForRefPath(ctx, nodeId, path, opts);
    }

    // Bare `$` or `$<partial-id>` → complete upstream ids.
    const dollarMatch = /\$([A-Za-z_][A-Za-z0-9_-]*)?$/.exec(before);
    if (dollarMatch) {
      const partial = dollarMatch[1] ?? '';
      const fromOffset = ctx.pos - partial.length;
      return {
        from: fromOffset,
        options: opts.upstreamIds.map(id => ({ label: id, type: 'variable' })),
        validFor: /^[A-Za-z0-9_-]*$/,
      };
    }

    return null;
  };
}

function completeForRefPath(
  ctx: CompletionContext,
  nodeId: string,
  path: string[],
  opts: Options
): CompletionResult | null {
  if (path.length === 0) {
    return {
      from: ctx.pos,
      options: [{ label: 'output', type: 'property' }],
      validFor: /^[A-Za-z0-9_]*$/,
    };
  }
  if (path.length === 1 && path[0] === 'output') {
    const fmt = opts.outputFormatLookup(nodeId);
    if (!fmt) return null;
    const properties = (fmt.properties as Record<string, { type?: string }> | undefined) ?? {};
    const entries = Object.entries(properties);
    if (entries.length === 0) return null;
    return {
      from: ctx.pos,
      options: entries.map(([key, schema]) => ({
        label: key,
        type: 'property',
        detail: schema.type ?? '',
      })),
      validFor: /^[A-Za-z0-9_]*$/,
    };
  }
  // Deeper paths (e.g., `$id.output.address.`) — v1 does not recurse into nested objects.
  return null;
}

/**
 * Convenience: returns the wrapped extension. Consumers that need to compose
 * with other extensions can call `whenAutocomplete(opts)` directly to get the
 * raw completion source instead.
 */
export function whenAutocompleteExtension(opts: Options): Extension {
  return autocompletion({ override: [whenAutocomplete(opts)] });
}
