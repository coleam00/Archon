/**
 * Pure parser/formatter/DNF-detector for Archon's `when:` expression grammar.
 *
 * Mirror of Archon's evaluator at the SHA in `.archon-source-pin`. The
 * authoritative grammar reference is `grammar.archon.md` in this directory.
 * Drift CI (`scripts/check-when-grammar-drift.ts`) keeps this module aligned.
 *
 * **Implementation strategy.** Upstream's evaluator is not a parser: it
 * splits the input textually on `||` then on `&&` (both respecting single-
 * quoted regions), and runs an atom regex on each piece. This module mirrors
 * that exactly. There is no real recursive descent — every accept/reject
 * decision is the upstream behavior, by construction.
 *
 * **Deviation from Phase 5 plan §5.2.** The plan called for a recursive-
 * descent parser supporting parens and unquoted number/boolean literals.
 * Reading upstream `condition-evaluator.ts` showed that contract is wider
 * than what Archon actually accepts. Studio is a mirror, so this module
 * implements the upstream surface: 6 operators (==, !=, <, >, <=, >=),
 * single-quoted strings only, at-most-one field segment after `.output`, no
 * parens. The deviation is recorded in `phase-5-drift-notes.md`.
 *
 * No React imports — this module is consumed by the store, validation
 * pipeline (Phase 6), and Inspector UI alike.
 */

export type WhenOp = '==' | '!=' | '<' | '>' | '<=' | '>=';

export interface AtomNode {
  kind: 'atom';
  ref: { nodeId: string; path: string[] };
  op: WhenOp;
  /**
   * The raw quoted value (without the surrounding `'…'`). Upstream stores
   * everything as a string and re-parses with `parseFloat` for numeric ops —
   * we keep the same representation so format/parse round-trip the bytes.
   */
  value: string;
}

export type WhenAst =
  | { kind: 'or'; children: WhenAst[] }
  | { kind: 'and'; children: WhenAst[] }
  | AtomNode;

export interface DnfAst {
  kind: 'or';
  children: { kind: 'and'; children: AtomNode[] }[];
}

export type ParseResult = { ok: true; ast: WhenAst } | { ok: false; error: string };

/**
 * Atom regex — copied from Archon's `condition-evaluator.ts`.
 *
 * - `nodeId`: starts with letter/underscore, then letters/digits/underscore/hyphen.
 * - optional `.field` after `.output`, field is letters/digits/underscore only.
 * - operator: one of the six.
 * - value: single-quoted, no escapes (anything but `'`).
 */
const ATOM_REGEX =
  /^\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?\s*(==|!=|<=|>=|<|>)\s*'([^']*)'$/;

/**
 * Split a string on `sep`, but only when not inside single-quoted regions.
 * Mirror of upstream `splitOutsideQuotes`. Returns at least one element.
 */
function splitOutsideQuotes(expr: string, sep: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  let i = 0;
  while (i < expr.length) {
    if (expr[i] === "'") {
      inQuote = !inQuote;
      current += expr[i++];
    } else if (!inQuote && expr.startsWith(sep, i)) {
      parts.push(current.trim());
      current = '';
      i += sep.length;
    } else {
      current += expr[i++];
    }
  }
  parts.push(current.trim());
  return parts;
}

function parseAtom(src: string): AtomNode | null {
  const m = ATOM_REGEX.exec(src.trim());
  if (!m) return null;
  const [, nodeId, field, op, value] = m;
  const path = field === undefined ? ['output'] : ['output', field];
  return {
    kind: 'atom',
    ref: { nodeId: nodeId, path },
    op: op as WhenOp,
    value: value,
  };
}

export function parse(input: string): ParseResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'empty expression' };
  }

  const orClauses = splitOutsideQuotes(trimmed, '||');
  const andGroups: { kind: 'and'; children: AtomNode[] }[] = [];

  for (const orClause of orClauses) {
    if (orClause.length === 0) {
      return { ok: false, error: 'empty || clause' };
    }
    const andAtoms = splitOutsideQuotes(orClause, '&&');
    const atoms: AtomNode[] = [];
    for (const atomSrc of andAtoms) {
      if (atomSrc.length === 0) {
        return { ok: false, error: 'empty && clause' };
      }
      const atom = parseAtom(atomSrc);
      if (!atom) {
        return { ok: false, error: `unparseable atom: ${JSON.stringify(atomSrc)}` };
      }
      atoms.push(atom);
    }
    andGroups.push({ kind: 'and', children: atoms });
  }

  // Collapse to the simplest shape consistent with the source.
  if (andGroups.length === 1) {
    const only = andGroups[0];
    if (only.children.length === 1) return { ok: true, ast: only.children[0] };
    return { ok: true, ast: only };
  }
  return {
    ok: true,
    ast: {
      kind: 'or',
      children: andGroups.map(g => (g.children.length === 1 ? g.children[0] : g)),
    },
  };
}

function formatAtom(a: AtomNode): string {
  // path is always ['output', ...maybeField]; the field segment is optional.
  const tail = a.ref.path.slice(1);
  const ref =
    tail.length > 0 ? `$${a.ref.nodeId}.output.${tail.join('.')}` : `$${a.ref.nodeId}.output`;
  return `${ref} ${a.op} '${a.value}'`;
}

export function format(ast: WhenAst): string {
  if (ast.kind === 'atom') return formatAtom(ast);
  if (ast.kind === 'and') {
    if (ast.children.length === 1) return format(ast.children[0]);
    return ast.children.map(format).join(' && ');
  }
  return ast.children.map(format).join(' || ');
}

/**
 * Return a DNF view of `ast` if expressible as OR-of-ANDs-of-atoms,
 * otherwise `null`.
 *
 * Since `parse` only produces DNF-shaped trees (upstream grammar has no
 * parens, so nesting beyond two levels is structurally impossible), this is
 * total over parse output. It still returns `null` for hand-built ASTs that
 * violate the shape — that branch matters for the visual builder reducer
 * which synthesizes ASTs without going through `parse`.
 */
export function toDnf(ast: WhenAst): DnfAst | null {
  if (ast.kind === 'atom') {
    return { kind: 'or', children: [{ kind: 'and', children: [ast] }] };
  }
  if (ast.kind === 'and') {
    if (!ast.children.every((c): c is AtomNode => c.kind === 'atom')) return null;
    return { kind: 'or', children: [{ kind: 'and', children: ast.children }] };
  }
  const groups: { kind: 'and'; children: AtomNode[] }[] = [];
  for (const child of ast.children) {
    if (child.kind === 'atom') {
      groups.push({ kind: 'and', children: [child] });
    } else if (
      child.kind === 'and' &&
      child.children.every((c): c is AtomNode => c.kind === 'atom')
    ) {
      groups.push({ kind: 'and', children: child.children });
    } else {
      return null;
    }
  }
  return { kind: 'or', children: groups };
}
