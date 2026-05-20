# Archon `when:` evaluator — grammar mirror

**Source:** `https://github.com/coleam00/Archon/blob/fd6d75e/packages/workflows/src/condition-evaluator.ts`
**Pinned SHA:** `fd6d75e` (matches `.archon-source-pin`)
**Last verified:** 2026-05-10

This document is the canonical grammar contract that
`packages/studio-core/src/lib/grammar.ts` implements. The drift CI in
`scripts/check-when-grammar-drift.ts` re-fetches the upstream source and fails
if the operator set, connective set, or value-type rules diverge from what is
documented here.

## Atom shape (authoritative regex from upstream)

```
^\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?\s*(==|!=|<=|>=|<|>)\s*'([^']*)'$
```

An atom is exactly one of:

```
$nodeId.output         OP 'value'
$nodeId.output.field   OP 'value'
```

- **nodeId**: matches `[a-zA-Z_][a-zA-Z0-9_-]*` — first char letter or
  underscore; subsequent chars may include hyphens. (Note: hyphens are allowed
  in nodeId but NOT in field names.)
- **field** (optional): a single segment matching `[a-zA-Z_][a-zA-Z0-9_]*`. The
  upstream evaluator supports **at most one** level of field access after
  `.output.`; deeper paths like `$a.output.x.y` do not match the atom regex and
  are rejected as unparseable (fail-closed).
- **value**: must be **single-quoted**. Double quotes are not supported by the
  upstream regex. Empty value (`''`) is legal.

## Operators

| Operator | Studio v1 supports | Notes                                                                               |
| -------- | ------------------ | ----------------------------------------------------------------------------------- |
| `==`     | yes                | string equality of resolved value vs literal                                        |
| `!=`     | yes                | string inequality                                                                   |
| `<`      | yes                | numeric; both sides must parse as finite numbers via `parseFloat`, else fail-closed |
| `>`      | yes                | numeric; same finite-number rule                                                    |
| `<=`     | yes                | numeric; same finite-number rule                                                    |
| `>=`     | yes                | numeric; same finite-number rule                                                    |

No other operators (no `in`, `not in`, `contains`, regex, etc.) are recognized
by the upstream evaluator. The studio MUST NOT expose operators outside this
list in the visual atom row.

## Logical connectives

| Connective | Studio v1 supports | Notes                                                                                                                                    |
| ---------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `&&`       | yes                | AND, higher precedence                                                                                                                   |
| `\|\|`     | yes                | OR, lower precedence                                                                                                                     |
| `(` `)`    | no                 | upstream evaluator does NOT support parentheses; expressions are split textually on `\|\|` first then on `&&`. Quoted regions respected. |

**Precedence:** `||` is split first (lower precedence), then each OR clause is
split on `&&`. There is no parser — splitting is purely textual via
`splitOutsideQuotes`. Therefore the _only_ expressible shape is **disjunctive
normal form** (OR of ANDs). The visual builder enforces DNF; the raw editor
accepts the same DNF surface.

## Value types

Only **single-quoted string literals**, e.g. `'bug'`, `'high'`, `''`.

- The atom regex's `'([^']*)'` captures everything between the outer quotes.
  There are NO escape sequences — an embedded `'` is impossible (it would close
  the literal early and break the atom match).
- Numeric comparisons re-parse the captured string via `parseFloat`. So
  `$a.output > '80'` works because both sides parse as numbers — the _literal_
  is still a quoted string at the grammar level.
- Booleans and null are not first-class. A boolean output value is coerced via
  `String(value)` upstream (giving `'true'`/`'false'`) and then compared as a
  string.

## Reference shape

```
$nodeId(.output)(.field)?
```

- Always starts with `$`.
- Always followed by literal `.output`.
- At most one additional `.field` segment.
- Field paths deeper than one segment (`$a.output.x.y`) are unparseable.
- Field values are resolved by `JSON.parse(nodeOutput.output)` then property
  access. Non-string scalars (`number`, `boolean`) are coerced via `String(...)`.
  Nested objects, `null`, `undefined`, `symbol`, `bigint` resolve to the empty
  string.

## Empty / null semantics

- The evaluator itself does NOT short-circuit on empty input. Calling
  `evaluateCondition('', ...)` runs the atom regex on `''`, which fails to
  match, and the whole call returns `{ result: false, parsed: false }` —
  fail-closed.
- Upstream callers (DAG executor) treat _missing_ `when:` (i.e. `null` /
  `undefined`) as "always run." Studio mirrors this: an empty `when:` string
  serialized to YAML is collapsed to `null` (see `GeneralTab` empty-string
  collapse), and YAML import treats `when: null` and "no `when:` key at all"
  identically.

## Whitespace

- The atom regex allows `\s*` around the operator. Leading/trailing whitespace
  on each atom and around `&&` / `||` is tolerated (atoms are `.trim()`-ed).
- Whitespace _inside_ quoted values is preserved as part of the value.

## Notes for studio implementers

- v1 visual builder restricts to DNF (OR-of-ANDs). Any input parseable by
  upstream is editable in raw mode; visual mode is offered only when the parse
  tree's top level is `or → and → atom` (or simpler).
- Atom row dropdown only exposes ops in this document's "Studio v1 supports =
  yes" column. Today that's all six (==, !=, <, >, <=, >=).
- The visual builder MUST emit single-quoted literals only — never double
  quotes, never unquoted.
- The visual builder MUST cap field access at one segment after `.output.`.
  Deeper paths are not expressible in upstream and must round-trip as raw.
- The studio's parser is fail-closed on the same inputs upstream is fail-closed
  on — there is no "tolerant" parsing.
