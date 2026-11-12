# Docs Review — Documentation Impact

Find this class of defect: **after this change, someone following the repository's documentation would form a materially wrong expectation or lack a required step.** Wrong documentation is worse than missing documentation; unnecessary documentation is maintenance debt. Before you start, read `review-lens.md` (`.archon/sdlc/policy/`, over the default in `$PACK_DIR/.shared/policy/`): it says how a lens stays read-only, where scratch work goes, what counts as a finding, and how a discovery is recorded. Your scratch worktree is `git worktree add --detach "$(mkdir -p "$ARTIFACTS_DIR/.archon/scratch/docs" && mktemp -d "$ARTIFACTS_DIR/.archon/scratch/docs/XXXXXX")" HEAD`, and your scratch files go under `$ARTIFACTS_DIR`.

Read `$ARTIFACTS_DIR/review/scope.md` first. The project's own values are in its steering documents: open, where the project has one, its `engineering.md` — at the root, in a config directory such as `.archon/`, or wherever its steering files point — only when a finding depends on a value it states, and read the section you cite, not the whole file. A preference it states is a finding you cite, and one it does not state is taste you leave out. Anchor the review on the accepted work order's stated invariants, and apply the supplied full-review policy: **$mode.output.risks**. On a continuation, scope.md names the prior report and the correction delta, and you examine only the delta. Read the prior report so you do not raise a finding again. When it holds a blocking finding still open whose `sources` include `docs`, you run to verify it: read `$ARTIFACTS_DIR/implementation.md`, judge each such finding as resolved by the delta, validly declined (the implementer's evidence holds), or still open, and check whether the fix introduced a new defect or side effect in this lens's area. Otherwise you run because the delta reaches new ground in this lens's area.

## A finding needs all four

1. The changed behavior, config, command, API, or architecture fact, with `file:line`.
2. The exact documentation surface now false — or the public task that cannot be completed from the current docs. Discover what documentation **this repository actually ships**: README, guides, reference docs, config samples, CLI help, contributor guidance, steering files, and generated docs whose source lives elsewhere. No universal exclusion list — find the authoritative copy before reporting drift.
3. The affected reader and the concrete wrong action.
4. The smallest correction in the document's existing tone — and when the surface is generated, fix the **source** and note the regeneration step, never the mirror.

## Always flag

A documented statement, option, default, or example made false; removed behavior still advertised; a required migration or destructive step omitted; a public change users cannot discover; stale generated docs whose generation step was missed. When workflows, prompts, skills, or plugins ARE the product, their shipped documentation counts the same as any reference page. Before reporting either kind: verify the existing text is actually contradicted, not merely worded differently than you would word it, and confirm the reader cannot already discover the requirement through existing help, schema, or reference output.

A finding's correction covers every page that makes the same claim: search the documentation for the claim, not only the page the diff touched.

## Steering files

`AGENTS.md` / `CLAUDE.md` are steering, not changelogs. Suggest a change only when a stated rule is now false, a pointer moved, or a new durable invariant must guide future work. Smallest rule, reference the code, never duplicate it.

## What a finding costs

State what each finding costs if it merges — the concrete consequence and who meets it — and never assign it a severity: synthesis labels every finding. Name what a reader does wrong or cannot do because of it, and say whether the text is false, missing for behavior this change adds, or only improvable.

## Output

Write `$ARTIFACTS_DIR/review/docs.md`: each in-scope finding begins with `sources: [docs]`, followed by the four parts (quote the false text), then the examined-and-current list with confirming evidence. On a continuation, a verdict per prior `docs` finding you verified: still open, fixed at `<sha>`, or validly declined, with evidence. No findings is a valid result.

Your discoveries file is `$ARTIFACTS_DIR/discoveries/review-docs.json`, and your `source_node` is `docs`.

Verify every cited path is real, then reply with one line pointing to it: `review findings: $ARTIFACTS_DIR/review/docs.md` and the findings count.
