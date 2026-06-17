/**
 * Structured editor for a node's `when:` expression, ported from the
 * standalone studio's WhenBuilder/AtomRow and rebuilt over PR-1's grammar
 * (validation/when-grammar.ts).
 *
 * The wire `when:` string stays the source of truth: the raw input edits it
 * directly with live `parse()` feedback, and when the string parses, the
 * structured DNF rows (OR groups of AND atoms) edit the AST and write back
 * through `format()`. An unparseable string keeps the raw editor active and
 * shows the parse error — never silently rewritten.
 */
import { type ChangeEvent, type ReactElement } from 'react';
import { format, parse } from '../validation';
import type { AtomNode, WhenAst, WhenOp } from '../types';

interface WhenBuilderProps {
  value: string | undefined;
  /** Node ids this node may reference (its transitive upstream, or all others). */
  upstreamIds: readonly string[];
  onChange: (next: string | undefined) => void;
}

const OPS: readonly WhenOp[] = ['==', '!=', '<', '>', '<=', '>='];

const SMALL_INPUT =
  'rounded-[7px] border border-border bg-surface px-1.5 py-1 font-mono text-[11.5px] text-text-primary outline-none focus:border-accent-bright/60';

function emptyAtom(firstUpstream: string | undefined): AtomNode {
  return { nodeId: firstUpstream ?? 'node', op: '==', value: '' };
}

function AtomRow({
  atom,
  upstreamIds,
  onChange,
  onRemove,
}: {
  atom: AtomNode;
  upstreamIds: readonly string[];
  onChange: (next: AtomNode) => void;
  onRemove: () => void;
}): ReactElement {
  const known = upstreamIds.includes(atom.nodeId);
  return (
    <div className="flex items-center gap-1">
      <select
        aria-label="Node"
        value={atom.nodeId}
        onChange={(e: ChangeEvent<HTMLSelectElement>): void => {
          onChange({ ...atom, nodeId: e.target.value });
        }}
        className={SMALL_INPUT}
      >
        {!known && atom.nodeId.length > 0 ? (
          <option value={atom.nodeId}>{`$${atom.nodeId} (dangling)`}</option>
        ) : null}
        {upstreamIds.map(id => (
          <option key={id} value={id}>{`$${id}`}</option>
        ))}
      </select>
      <span className="font-mono text-[11px] text-text-tertiary">.output.</span>
      <input
        aria-label="Field"
        type="text"
        value={atom.field ?? ''}
        placeholder="(none)"
        spellCheck={false}
        onChange={(e: ChangeEvent<HTMLInputElement>): void => {
          const field = e.target.value.trim();
          // Editing the field canonicalizes the PATH: the `shorthand`
          // (`$node.field`) flag is intentionally not carried over, so the atom
          // re-serializes as the canonical `$node.output.field`. The `bare` RHS
          // spelling (unquoted number/boolean) is preserved as the author wrote it.
          const next: AtomNode = { nodeId: atom.nodeId, op: atom.op, value: atom.value };
          if (field.length > 0) next.field = field;
          if (atom.bare === true) next.bare = true;
          onChange(next);
        }}
        className={`${SMALL_INPUT} w-20 min-w-0 flex-1`}
      />
      <select
        aria-label="Operator"
        value={atom.op}
        onChange={(e: ChangeEvent<HTMLSelectElement>): void => {
          onChange({ ...atom, op: e.target.value as WhenOp });
        }}
        className={SMALL_INPUT}
      >
        {OPS.map(op => (
          <option key={op} value={op}>
            {op}
          </option>
        ))}
      </select>
      <input
        aria-label="Value"
        type="text"
        value={atom.value}
        spellCheck={false}
        onChange={(e: ChangeEvent<HTMLInputElement>): void => {
          onChange({ ...atom, value: e.target.value });
        }}
        className={`${SMALL_INPUT} w-16 min-w-0 flex-1`}
      />
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove condition"
        className="rounded px-1 text-[13px] leading-none text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary"
      >
        ×
      </button>
    </div>
  );
}

export function WhenBuilder({ value, upstreamIds, onChange }: WhenBuilderProps): ReactElement {
  const raw = value ?? '';
  const parsed = raw.trim().length > 0 ? parse(raw) : null;

  const emit = (ast: WhenAst): void => {
    onChange(format(ast));
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-text-tertiary">
        When (condition)
      </span>
      <input
        type="text"
        value={raw}
        placeholder="$node.output == 'value' && …"
        spellCheck={false}
        onChange={(e: ChangeEvent<HTMLInputElement>): void => {
          const next = e.target.value;
          onChange(next.trim().length > 0 ? next : undefined);
        }}
        className="w-full rounded-[8px] border border-border bg-surface px-2 py-1.5 font-mono text-[12px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent-bright/60"
      />
      {parsed !== null && !parsed.ok ? (
        <p className="text-[11px] text-error">{parsed.error}</p>
      ) : null}

      {parsed?.ok === true ? (
        <div className="flex flex-col gap-1.5">
          {parsed.ast.or.map((group, gi) => (
            <div key={gi} className="flex flex-col gap-1">
              <div className="flex flex-col gap-1 rounded-[8px] border border-border bg-surface-inset p-1.5">
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-text-tertiary">
                  all of
                </span>
                {group.map((atom, ai) => (
                  <AtomRow
                    key={ai}
                    atom={atom}
                    upstreamIds={upstreamIds}
                    onChange={(nextAtom): void => {
                      emit({
                        or: parsed.ast.or.map((g, i) =>
                          i === gi ? g.map((a, j) => (j === ai ? nextAtom : a)) : g
                        ),
                      });
                    }}
                    onRemove={(): void => {
                      emit({
                        or: parsed.ast.or
                          .map((g, i) => (i === gi ? g.filter((_, j) => j !== ai) : g))
                          .filter(g => g.length > 0),
                      });
                    }}
                  />
                ))}
                <button
                  type="button"
                  onClick={(): void => {
                    emit({
                      or: parsed.ast.or.map((g, i) =>
                        i === gi ? [...g, emptyAtom(upstreamIds[0])] : g
                      ),
                    });
                  }}
                  className="self-start rounded border border-dashed border-border px-1.5 py-0.5 text-[10.5px] text-text-tertiary transition-colors hover:text-text-primary"
                >
                  + and
                </button>
              </div>
              {gi < parsed.ast.or.length - 1 ? (
                <span className="text-center font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-text-tertiary">
                  or
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {parsed === null || (parsed.ok && parsed.ast.or.length === 0) ? (
        <button
          type="button"
          onClick={(): void => {
            emit({ or: [[emptyAtom(upstreamIds[0])]] });
          }}
          className="self-start rounded border border-dashed border-border px-2 py-1 text-[11px] text-text-tertiary transition-colors hover:text-text-primary"
        >
          + Add condition
        </button>
      ) : (
        parsed.ok && (
          <button
            type="button"
            onClick={(): void => {
              emit({ or: [...parsed.ast.or, [emptyAtom(upstreamIds[0])]] });
            }}
            className="self-start rounded border border-dashed border-border px-2 py-1 text-[11px] text-text-tertiary transition-colors hover:text-text-primary"
          >
            + Add OR group
          </button>
        )
      )}
    </div>
  );
}
