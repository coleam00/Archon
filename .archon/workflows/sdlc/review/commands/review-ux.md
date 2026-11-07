# UX Review — Does it work for the person using it

Use this change as its operator would, and judge whether it is clear, responsive and honest. Other lenses judge whether the code is correct; you judge what a person meets on the screen. Read `$ARTIFACTS_DIR/review/scope.md` first for the change and its work order, and judge the change against what the work order says its user needs.

Start the app from a scratch worktree under this run (`git worktree add --detach "$(mkdir -p "$ARTIFACTS_DIR/.archon/scratch/ux" && mktemp -d "$ARTIFACTS_DIR/.archon/scratch/ux/XXXXXX")" HEAD`; the workflow removes it; install its dependencies with the project's own package manager in locked mode) and drive it with playwright-cli: `$playwright-cli` where skills are invoked that way, otherwise the `playwright-cli` command and its `SKILL.md` in the project's or your skills directory. Seed the data a page needs through the app's own API or CLI. Look at it the way its user would, at the sizes they would use it.

What to judge:

- **Clear:** can the user tell what they are looking at, what each label and number means, and what to do next, without reading the code?
- **Responsive:** does every action answer promptly, and does a slow or failed one say what is happening and offer a way forward?
- **Honest:** does the screen ever mislead — a figure that reads as something it isn't, an empty state that looks broken, a state the user can't distinguish from another?

A finding is what a person fails to understand or do, shown in a screenshot or snapshot under `$ARTIFACTS_DIR/review/ui/`, with the smallest fix. A preference with no such consequence is silence.

Rules:

- Never run it on the user's real data or a live database. `ui-check.md` (`.archon/sdlc/policy/`, over the default in `$PACK_DIR/.shared/policy/`) says how this project starts safely.
- Never modify this checkout or post anywhere: sibling reviewers read it at the same time, and the engine fails a reviewer that leaves it changed. Scratch files go under `$ARTIFACTS_DIR`.
- Stop exactly what you started.
- If you could not run it, say so; do not judge the UX from the code alone.

## Output

Write `$ARTIFACTS_DIR/review/ux.md`: each finding begins with `sources: [ux]`, then what the user meets and what it costs them, the screenshot, the `file:line` that produces it, and the smallest fix. Never assign a severity: synthesis labels every finding. Then list what you exercised and found clear. On a continuation round, scope.md names the prior report: give a verdict per prior `ux` finding (still open / fixed / disproved, with evidence), then judge the delta.

A UX problem you meet that the change did not cause is a discovery: write `$ARTIFACTS_DIR/discoveries/review-ux.json` as a JSON array of records with `title`, `claim`, `evidence`, `relation` (`unrelated` or `scope_conflict`) and `source_node` (`ux`). Write no file for no discovery.

Verify the file exists, then reply with one line pointing to it: `review findings: $ARTIFACTS_DIR/review/ux.md` and the findings count.
