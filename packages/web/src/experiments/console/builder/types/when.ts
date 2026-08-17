/**
 * AST types for the `when:` expression grammar.
 *
 * Wire syntax: `$<nodeId>.output[.<field>]` (canonical), `$<nodeId>.<field>`
 * (shorthand) or `$INPUTS.<name>` (a declared workflow input), compared against a
 * single-quoted string or a bare number/boolean, joined by `||` (outer / OR) and
 * `&&` (inner / AND). The AST is in disjunctive normal form: an outer OR of inner
 * AND-groups of atoms.
 */

/** The six supported comparison operators. */
export type WhenOp = '==' | '!=' | '<' | '>' | '<=' | '>=';

/** Fields every atom carries, whatever its left-hand side refers to. */
interface AtomComparison {
  op: WhenOp;
  value: string;
  /**
   * Present (true) when the RHS was written bare (unquoted number/boolean)
   * rather than single-quoted. Preserved so `format()` round-trips the
   * author's spelling.
   */
  bare?: boolean;
}

/** A comparison against a node's output: `$nodeId.output[.field] op value`. */
export interface NodeAtom extends AtomComparison {
  kind: 'node';
  nodeId: string;
  /** Field on the output — undefined for a bare `$nodeId.output`. */
  field?: string;
  /**
   * Present (true) when the path was written as the `$nodeId.field` shorthand
   * rather than the canonical `$nodeId.output.field`. Preserved so `format()`
   * round-trips the author's spelling. Implies `field` is defined.
   */
  shorthand?: boolean;
}

/**
 * A comparison against a declared workflow input: `$INPUTS.name op value`.
 *
 * `INPUTS` is a reserved scope, not a node — the engine's schema rejects it as a
 * node id outright — so an input atom carries no `nodeId` and no `field`, and the
 * builder must not offer it the node picker or the upstream-dependency check.
 */
export interface InputAtom extends AtomComparison {
  kind: 'input';
  name: string;
}

/** A single comparison atom. */
export type AtomNode = NodeAtom | InputAtom;

/** Disjunctive normal form: outer OR of inner AND-groups. */
export interface WhenAst {
  or: AtomNode[][];
}

/** Result of parsing a `when:` expression. */
export type ParseResult = { ok: true; ast: WhenAst } | { ok: false; error: string };
