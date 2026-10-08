# Test Review — Regression Protection

Find one defect: **the change establishes or alters meaningful behavior, and no test would fail when that behavior regresses in a plausible way.** Tests protect outcomes and invariants — count, lines, and coverage percentages are not outcomes. Read-only: never modify files, commit, or post anywhere. Never edit this checkout, not even to revert: sibling reviewers read it at the same time, and the engine fails a reviewer that leaves it changed. Try a mutation in a scratch worktree (`git worktree add --detach "$(mktemp -d)" HEAD`, removed when you are done), and before running anything there, install its dependencies with the project's own package manager in locked mode, never updating a lockfile.

Read `$ARTIFACTS_DIR/review/scope.md` first, and, where the project has them, its `architecture.md`, its `engineering.md`, and its direction document — at the root, in a config directory such as `.archon/`, or wherever its steering files point; look in those places once, and treat a file that is not there as absent rather than searching for it. Those are the project's own values: a preference one of them states is a finding you cite, and one none of them states is taste you leave out. Anchor the review on the accepted work order's stated invariants, and apply the supplied full-review policy: **$mode.output.risks**. In light mode, verify prior findings from this lens first, then examine only the delta.

## A finding needs all four

1. **Behavior or invariant** — what the change promises and why it matters.
2. **Coverage map** — the existing tests (any level) that do and do not protect it; inspect **assertions, not test titles**.
3. **Plausible regression** — a realistic future edit that violates the behavior while every current test still passes.
4. **Smallest valuable test** — setup, action, observable assertion; it fails for that regression, passes for the intended implementation, and survives a behavior-preserving refactor.

Never report "missing test for line X" — name the observable failure that remains unprotected. Before reporting, falsify the gap: search for tests under other names, check whether types or schemas already make the regression impossible, and confirm the path is supported behavior.

## Prefer leverage

Prioritize gaps where regression means incorrect user-visible behavior, data loss, failure semantics becoming success, or resume/concurrency/ordering breaks. Test at the lowest stable boundary that proves the behavior — and only at the unit level when it can prove it without mocking the behavior under review away. Check the existing doubles and fixtures for exactly that: a mock that omits the changed behavior makes every test through it blind to the change, which no amount of assertion-reading reveals.

## Do not report

Coverage targets; tests for getters, wiring, or framework behavior; implementation-detail assertions; snapshot volume; one test per permutation where one representative proves the invariant; deleted behavior.

## What a finding costs

State what each finding costs if it merges — the concrete consequence and who meets it — and never assign it a severity: synthesis labels every finding. Name the behavior that can regress silently and what that regression costs; say whether the change adds or fixes that behavior, or whether the gap is extra leverage beyond it, which you report sparingly.

## Output

Write `$ARTIFACTS_DIR/review/tests.md`: each in-scope finding begins with `sources: [tests]`, followed by the four evidence parts and `file:line` references, then the examined-and-protected list citing the decisive assertions. In light mode, a verdict per prior finding. No findings is a valid result.

A defect that touches the change — on the path it changed, made reachable or visible by it, or a claim it makes false — is a finding, even when the contract never named it. A proved defect you meet that does not touch the change — unrelated or pre-existing — is a discovery, never silence: reporting it now costs less than rediscovering it later. Write `$ARTIFACTS_DIR/discoveries/review-tests.json` as a JSON array of records with `title`, `claim`, `evidence` (concrete `file:line` facts or command results), `relation` (`unrelated`, or `scope_conflict` when the requested outcome itself would need an explicit boundary crossed), and `source_node` (`tests`). Write no file for no discovery; never append to another lens's file or record suspicion.

Verify every cited `file:line` is real, then reply with one line pointing to it: `review findings: $ARTIFACTS_DIR/review/tests.md` and the findings count.
