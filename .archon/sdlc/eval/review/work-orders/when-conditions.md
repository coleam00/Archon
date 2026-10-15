# fix(workflows): a when: with parentheses loads without error and then silently never runs the node

## Problem

A `when:` expression that uses parentheses for grouping, such as `A && (B || C)`, loads without any error and then never runs the node. The condition grammar does not support grouping (`packages/workflows/src/condition-evaluator.ts`: "AND has higher precedence than OR. No parentheses."), and an expression the evaluator cannot parse is fail-closed: the node is skipped with `parsed: false`. The load-time `when:` validation (which shares the atom grammar in `when-atom.ts` so the two "can never disagree") does not reject the parentheses, so the author gets no signal at load or in `archon validate workflows`; the node is simply skipped at every run.

Found on 7 October 2026 while authoring an SDLC pack node in a pull request: `A && (B || C)` never ran; rewriting it as `A && B || A && C` worked.

## Why it matters

A silently skipped node is a silent behavior change in an agent workflow: the work the author meant to gate simply never happens, and nothing says why. AGENTS.md asks for unsupported or ambiguous states to fail early and clearly, and for no silent drop.

## Why now

Pack and workflow authors are writing more compound `when:` conditions as the SDLC pack grows; grouping is the natural way to write them.

## Desired outcome

An expression the evaluator cannot parse — parentheses included — is a load-time error that names the node and the unsupported syntax, in both workflow loading and `archon validate workflows`. A run never reaches a `when:` the evaluator cannot parse.

## Invariants

- No change to the condition grammar's semantics (still no grouping unless a separate decision adds it).
- Load-time validation and runtime evaluation keep sharing one grammar; they cannot disagree about whether an expression parses.
- Existing valid conditions in the bundled workflows still load (`archon validate workflows` reports 0 errors).

## Acceptance

- A workflow with `when: "$a.output == 'x' && ($b.output == 'y' || $c.output == 'z')"` fails to load with an error naming the node and the parentheses; a test shows this fails before the fix.
- A test asserts that every expression the runtime would treat as `parsed: false` is rejected at load.
- The authoring docs state that grouping is not supported and show the expanded form.

## Solution steering (optional)

Run the full expression parser (not only the atom grammar) during load-time `when:` validation, so any `parsed: false` result becomes a load error.
