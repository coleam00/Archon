# Docs Review — Documentation Impact

Find one defect: **after this change, someone following the repository's documentation would form a materially wrong expectation or lack a required step.** Wrong documentation is worse than missing documentation; unnecessary documentation is maintenance debt. Read-only: never modify files, commit, or post anywhere. Never edit this checkout, not even to revert: sibling reviewers read it at the same time, and the engine fails a reviewer that leaves it changed. Try a mutation in a scratch worktree (`git worktree add --detach "$(mktemp -d)" HEAD`, removed when you are done), and before running anything there, install its dependencies with the project's own package manager in locked mode, never updating a lockfile.

Read `$ARTIFACTS_DIR/review/scope.md` first, and, where the project has them, its `architecture.md`, its `engineering.md`, and its direction document — at the root, in a config directory such as `.archon/`, or wherever its steering files point; look in those places once, and treat a file that is not there as absent rather than searching for it. Those are the project's own values: a preference one of them states is a finding you cite, and one none of them states is taste you leave out. Anchor the review on the accepted work order's stated invariants, and apply the supplied full-review policy: **$mode.output.risks**. In light mode, verify prior findings from this lens first, then examine only the delta.

## A finding needs all four

1. The changed behavior, config, command, API, or architecture fact, with `file:line`.
2. The exact documentation surface now false — or the public task that cannot be completed from the current docs. Discover what documentation **this repository actually ships**: README, guides, reference docs, config samples, CLI help, contributor guidance, steering files, and generated docs whose source lives elsewhere. No universal exclusion list — find the authoritative copy before reporting drift.
3. The affected reader and the concrete wrong action.
4. The smallest correction in the document's existing tone — and when the surface is generated, fix the **source** and note the regeneration step, never the mirror.

## Always flag

A documented statement, option, default, or example made false; removed behavior still advertised; a required migration or destructive step omitted; a public change users cannot discover; stale generated docs whose generation step was missed. When workflows, prompts, skills, or plugins ARE the product, their shipped documentation counts the same as any reference page. Before reporting either kind: verify the existing text is actually contradicted, not merely worded differently than you would word it, and confirm the reader cannot already discover the requirement through existing help, schema, or reference output.

## Steering files

`AGENTS.md` / `CLAUDE.md` are steering, not changelogs. Suggest a change only when a stated rule is now false, a pointer moved, or a new durable invariant must guide future work. Smallest rule, reference the code, never duplicate it.

## What a finding costs

State what each finding costs if it merges — the concrete consequence and who meets it — and never assign it a severity: synthesis labels every finding. Name what a reader does wrong or cannot do because of it, and say whether the text is false, missing for behavior this change adds, or only improvable.

## Output

Write `$ARTIFACTS_DIR/review/docs.md`: each in-scope finding begins with `sources: [docs]`, followed by the four parts (quote the false text), then the examined-and-current list with confirming evidence. In light mode, a verdict per prior finding. No findings is a valid result.

A defect that touches the change — on the path it changed, made reachable or visible by it, or a claim it makes false — is a finding, even when the contract never named it. A proved defect you meet that does not touch the change — unrelated or pre-existing — is a discovery, never silence: reporting it now costs less than rediscovering it later. Write `$ARTIFACTS_DIR/discoveries/review-docs.json` as a JSON array of records with `title`, `claim`, `evidence` (concrete `file:line` facts or command results), `relation` (`unrelated`, or `scope_conflict` when the requested outcome itself would need an explicit boundary crossed), and `source_node` (`docs`). Write no file for no discovery; never append to another lens's file or record suspicion.

Verify every cited path is real, then reply with one line pointing to it: `review findings: $ARTIFACTS_DIR/review/docs.md` and the findings count.
