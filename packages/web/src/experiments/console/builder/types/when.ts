/**
 * AST types for the `when:` expression grammar.
 *
 * Wire syntax: `$<nodeId>.output[.<field>] <op> '<value>'`, joined by `||`
 * (outer / OR) and `&&` (inner / AND). The AST is in disjunctive normal form:
 * an outer OR of inner AND-groups of atoms.
 */

/** The six supported comparison operators. */
export type WhenOp = '==' | '!=' | '<' | '>' | '<=' | '>=';

/** A single comparison atom: `$nodeId.output[.field] op 'value'`. */
export interface AtomNode {
  nodeId: string;
  /** Optional field after `.output.` — undefined for a bare `$nodeId.output`. */
  field?: string;
  op: WhenOp;
  value: string;
}

/** Disjunctive normal form: outer OR of inner AND-groups. */
export interface WhenAst {
  or: AtomNode[][];
}

/** Result of parsing a `when:` expression. */
export type ParseResult = { ok: true; ast: WhenAst } | { ok: false; error: string };
