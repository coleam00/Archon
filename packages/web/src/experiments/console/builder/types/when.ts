/**
 * AST types for the `when:` expression grammar.
 *
 * Wire syntax: `$<nodeId>.output[.<field>]` (canonical) or `$<nodeId>.<field>`
 * (shorthand) compared against a single-quoted string or a bare number/boolean,
 * joined by `||` (outer / OR) and `&&` (inner / AND). The AST is in disjunctive
 * normal form: an outer OR of inner AND-groups of atoms.
 */

/** The six supported comparison operators. */
export type WhenOp = '==' | '!=' | '<' | '>' | '<=' | '>=';

/** A single comparison atom: `$nodeId.output[.field] op value`. */
export interface AtomNode {
  nodeId: string;
  /** Field on the output — undefined for a bare `$nodeId.output`. */
  field?: string;
  op: WhenOp;
  value: string;
  /**
   * Present (true) when the path was written as the `$nodeId.field` shorthand
   * rather than the canonical `$nodeId.output.field`. Preserved so `format()`
   * round-trips the author's spelling. Implies `field` is defined.
   */
  shorthand?: boolean;
  /**
   * Present (true) when the RHS was written bare (unquoted number/boolean)
   * rather than single-quoted. Preserved so `format()` round-trips the
   * author's spelling.
   */
  bare?: boolean;
}

/** Disjunctive normal form: outer OR of inner AND-groups. */
export interface WhenAst {
  or: AtomNode[][];
}

/** Result of parsing a `when:` expression. */
export type ParseResult = { ok: true; ast: WhenAst } | { ok: false; error: string };
