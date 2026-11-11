# Test Review — Regression Protection

A test earns its place when a plausible future break of behavior that matters makes it fail where no other test would. Judge the change's tests against that goal in both directions. **A gap:** the change establishes or alters meaningful behavior, and no test would fail when that behavior regresses in a plausible way. **An excess test:** a test the change adds fails only for regressions a kept test already catches, so it costs maintenance and protects nothing more. Tests protect outcomes and invariants — count, lines, and coverage percentages are not outcomes. Not every change needs a test, and a change with none is not a finding by itself. Before you start, read `review-lens.md` (`.archon/sdlc/policy/`, over the default in `$PACK_DIR/.shared/policy/`): it says how a lens stays read-only, where scratch work goes, what counts as a finding, and how a discovery is recorded. Your scratch worktree is `git worktree add --detach "$(mkdir -p "$ARTIFACTS_DIR/.archon/scratch/tests" && mktemp -d "$ARTIFACTS_DIR/.archon/scratch/tests/XXXXXX")" HEAD`, and your scratch files go under `$ARTIFACTS_DIR`.

Read `$ARTIFACTS_DIR/review/scope.md` first. The project's own values are in its steering documents: open, where the project has one, its `engineering.md` — at the root, in a config directory such as `.archon/`, or wherever its steering files point — only when a finding depends on a value it states, and read the section you cite, not the whole file. A preference it states is a finding you cite, and one it does not state is taste you leave out. Anchor the review on the accepted work order's stated invariants, and apply the supplied full-review policy: **$mode.output.risks**. On a continuation, scope.md names the prior report and the correction delta, and you examine only the delta. Read the prior report so you do not raise a finding again. When it holds a blocking finding still open whose `sources` include `tests`, you run to verify it: read `$ARTIFACTS_DIR/implementation.md`, judge each such finding as resolved by the delta, validly declined (the implementer's evidence holds), or still open, and check whether the fix introduced a new defect or side effect in this lens's area. Otherwise you run because the delta reaches new ground in this lens's area.

## A gap needs all four

1. **Behavior or invariant** — what the change promises and why it matters.
2. **Coverage map** — the existing tests (any level) that do and do not protect it; inspect **assertions, not test titles**.
3. **Plausible regression** — a realistic future edit that violates the behavior while every current test still passes.
4. **Smallest valuable test** — setup, action, observable assertion; it fails for that regression, passes for the intended implementation, and survives a behavior-preserving refactor.

Never report "missing test for line X" — name the observable failure that remains unprotected. Before reporting, falsify the gap: search for tests under other names, check whether types or schemas already make the regression impossible, and confirm the path is supported behavior.

## An excess test needs all three

1. **The test** — `file:line` and the outcome it asserts.
2. **What already protects that outcome** — the kept tests and assertions (`file:line`) that together fail for every regression this one catches; inspect **assertions, not test titles**.
3. **The smaller set to keep** — the tests that stay, and why every regression the dropped ones catch still fails one of them.

Look for a test that repeats an assertion at another layer, enumerates permutations one representative case proves, or re-proves a library, the schema or the type system, and for a test dependency the change brings in. A new test dependency is excess unless the behavior it proves matters and nothing the project already has can prove it: name what does. Judge only tests the change adds or edits.

## Prefer leverage

Prioritize gaps where regression means incorrect user-visible behavior, data loss, failure semantics becoming success, or resume/concurrency/ordering breaks. Test at the lowest stable boundary that proves the behavior — and only at the unit level when it can prove it without mocking the behavior under review away. Check the existing doubles and fixtures for exactly that: a mock that omits the changed behavior makes every test through it blind to the change, which no amount of assertion-reading reveals.

Never propose a test that re-runs a whole suite, a package, or the project's test command to prove an invariant. That repeats CI inside the suite, costs every future run, and fails on its time budget rather than on the behavior. Check such an invariant once yourself and cite the result; the test you propose, if any, exercises the behavior at the boundary that owns it.

## Do not report

Coverage targets; tests for getters, wiring, or framework behavior; behavior the engine, a library, or the type system already proves; prompt wording or configuration shape; a regression that no supported path reaches today or that the change's first real use would show at once; implementation-detail assertions; snapshot volume; one test per permutation where one representative proves the invariant; deleted behavior. Models overrate imagined regressions: a gap needs a regression someone could plausibly make in code that exists now.

## What a finding costs

State what each finding costs if it merges — the concrete consequence and who meets it; for an excess test, the lines, dependency and future edits it makes every maintainer carry — and never assign it a severity: synthesis labels every finding. A surviving mutation is evidence for a gap's part 3, not the whole of it: the regression must be an edit someone would plausibly make, and the test one the project would keep. On a behavior-preserving refactor, a gap the old code already had is not this change's finding unless the refactor made the regression more plausible. Name the behavior that can regress silently and what that regression costs; say whether the change adds or fixes that behavior, or whether the gap is extra leverage beyond it, which you report sparingly.

## Output

Write `$ARTIFACTS_DIR/review/tests.md`: each in-scope finding begins with `sources: [tests]`, followed by its evidence parts (a gap's four or an excess test's three) and `file:line` references, then the examined-and-protected list citing the decisive assertions. On a continuation, a verdict per prior `tests` finding you verified: still open, fixed at `<sha>`, or validly declined, with evidence. No findings is a valid result.

Your discoveries file is `$ARTIFACTS_DIR/discoveries/review-tests.json`, and your `source_node` is `tests`.

Verify every cited `file:line` is real, then reply with one line pointing to it: `review findings: $ARTIFACTS_DIR/review/tests.md` and the findings count.
