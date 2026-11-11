# Code Review — Correctness

Find defects the change introduces. Do not grade the code, summarize the diff, or reward activity. Before you start, read `review-lens.md` (`.archon/sdlc/policy/`, over the default in `$PACK_DIR/.shared/policy/`): it says how a lens stays read-only, where scratch work goes, what counts as a finding, and how a discovery is recorded. Your scratch worktree is `git worktree add --detach "$(mkdir -p "$ARTIFACTS_DIR/.archon/scratch/code" && mktemp -d "$ARTIFACTS_DIR/.archon/scratch/code/XXXXXX")" HEAD`, and your scratch files go under `$ARTIFACTS_DIR`. Your findings go in a file; the synthesizer aggregates them.

Read `$ARTIFACTS_DIR/review/scope.md` first. Then review exactly the diff scope.md describes. The project's own values are in its steering documents: open, where the project has them, its `engineering.md` and its direction document — at the root, in a config directory such as `.archon/`, or wherever its steering files point — only when a finding depends on a value one of them states, and read the section you cite, not the whole file. A preference one of them states is a finding you cite, and one none of them states is taste you leave out. Anchor the review on the accepted work order's stated invariants, and apply the supplied full-review policy: **$mode.output.risks**. On a continuation, scope.md names the prior report and the correction delta, and you run on every continuation: read the prior report and `$ARTIFACTS_DIR/implementation.md`, judge every prior finding, whichever lens raised it (a lens with an open prior blocker also reruns to verify its own), as resolved by the delta, validly declined (the implementer's evidence holds), or still open, then apply the same bar to the delta only.

## Evidence bar — report only what is proved

1. **Behavioral defect** — a reachable input or state produces an outcome that contradicts the change's required behavior, an existing contract, or a supported caller's expectation.
2. **Repository-rule violation** — the changed code violates an explicit applicable rule in the repo's steering files (`AGENTS.md`, `CLAUDE.md`, contributor guidance) or enforced configuration. A preference no project document states is not a rule, and framework folklore is not a project rule.

Every finding needs: the changed line that causes it, the reachable path (caller, input, or state), the incorrect outcome, evidence (code, test, config, or command output), and the smallest correction. If the causal chain contains "might" or "could", investigate until it is concrete or drop it. **Everything unproved is silence.**

For each new branch, predicate, log line or interpolation, list the states and inputs that reach it beyond the work order's examples (other lifecycle statuses, wrong file type, whitespace or separators in configured values, each capability variant, throw versus return) and judge each. Trace cleanup, cancellation and logging for already-terminal states as well as in-flight work. A predicate's name is not evidence of status or capability gating; quote the checks it actually makes. For an enumerated state, start from its defining type, list every member, and trace each to the changed guard. Keep independent dimensions separate: event causes or UI modes do not stand in for lifecycle statuses.

For changed returns whose consumers require accumulated state, start at the final consumer and trace backwards through every enclosing wrapper to the work that accumulates it. Write the expression that consumer receives for a nonzero value on each exit, including defaults for absent fields. Distinguish a snapshot constructed before the work from a result constructed after it: quote the construction and the writes that put accumulated values into the actual returned object. An inner return carrying totals does not clear an outer return that serializes the original snapshot. Compare success, pause/defer, failure and retry paths; nonterminal outcomes are still observed by callers. Finish this exit inventory even when another defect is already proved.

When several rules guard one invariant, such as admitting, draining and resuming the same work, or two authentication modes for one action, write their predicates side by side. A difference you cannot explain is a finding. After a predicate fix, check the reverse case: the input the old predicate handled that the new one must still handle.

## Comments are part of correctness

Comments clarify functionality and how code is used, and they stay current when behavior changes. Never request a comment on self-explanatory code; request removal or editing of comments on self-explanatory code instead. Code that is not self-explanatory is usually too complex and the finding is simplification, not narration. A missing comment is reportable only when the change introduces durable knowledge that code or types cannot express: a surprising external constraint, a non-obvious safety or ordering requirement, a deliberate compatibility compromise a future maintainer could clean up and break, or operational behavior not discoverable from the local code. Never request narration of control flow, parameter names, or implementation steps.

Report a comment defect only when the changed prose creates the same concrete maintenance or supported-use consequence required by the evidence bar above. Quote the prose and the contradicting behavior. A self-explanatory changed comment is a repository-rule violation: request its removal or editing, never additional narration.

## Scope of reading

Leave the diff far enough to understand the changed behavior: read full changed files, direct callers, consumers, and tests — at most two hops from changed lines. Read the repo's steering files before judging rule violations. Do not audit unrelated code: the bound limits where you search, not what you report. A pre-existing defect is a finding when this change makes it reachable, worsens it, or claims to fix it without doing so; one you meet that the change does not touch is a discovery (see Output).

When the change adds a site of a pattern the file already implements elsewhere, compare the new site's behavior with the existing one. Investigate a difference and report it when the evidence bar proves a violated contract.

The two-hop bound governs ordinary search. Once one concrete defect proves that a member of a finite class violates the same invariant, enumerate that class with a deterministic repository search and finish it before reporting. Emit one causal finding with the invariant, discovery method, all affected members, and all examined-clean members. For a proved return-payload loss, enumerate all returns in the affected functions and their wrappers, including exits with different triggers. Quote each losing construction and any preserving sibling construction, and name the search that establishes the class is complete. Do not use class completion to start an unrelated audit.

When execution is practical, run the smallest command that can falsify a finding. Invoke it the way this repository documents its own commands — the package scripts and invocation rules its steering files name, never an ad-hoc variant one of them warns against — and treat an environment-dependent failure as suspect until you reproduce it that documented way. A passing broad suite is not proof an untested path is correct. A falsifying command creates whatever it needs — a scratch database you create and drop, never a configured live DSN — and never writes to a resource you did not create. If only a live resource could settle a finding, leave it unfalsified and say so.

## Use a user-facing change

When the change is something a person sees or does in a browser, find out whether it works for that person. Reading the code is not enough: start the app from your scratch worktree and use it, driving it with playwright-cli (`$playwright-cli` where skills are invoked that way, otherwise the `playwright-cli` command and its `SKILL.md` in the project's or your skills directory). A flow that is broken, stuck, wrong or misleading for its user is a finding, with a screenshot or snapshot under `$ARTIFACTS_DIR/review/ui/` as evidence.

- Never run it on the user's real data or a live database. `ui-check.md` (`.archon/sdlc/policy/`, over the default in `$PACK_DIR/.shared/policy/`) says how this project starts safely.
- Stop exactly what you started.
- If you could not run it, say so and review the code alone.

## What a finding costs

State what each finding costs if it merges — the concrete consequence and who meets it — and never assign it a severity: synthesis labels every finding. Report only a reachable supported path that is wrong or broken, or an explicit repository invariant the change violates; anything weaker is silence. A risk you can imagine but no supported path reaches today is silence too, not a note.

When a clearance describes a predicate or contract, quote the actual code or config with its source, never your own characterization. If you cannot quote it, mark it unverified and leave it off the clean list.

Record the examined input/state domain with its quoted predicates, including the states that cleared each suspicious branch; a named variant without a traced path is unverified.

## Output

Write `$ARTIFACTS_DIR/review/code.md`: each in-scope finding begins with `sources: [code]`, followed by what it costs, the evidence fields above, and `file:line` references; then an "examined and clean" list naming the specific contracts or callers that cleared the suspicious spots; on a continuation, a verdict per prior finding (still open / fixed at `<sha>` / disproved, with evidence). If there are no findings, say so and name what was decisively checked — never claim the whole change is correct.

Your discoveries file is `$ARTIFACTS_DIR/discoveries/review-code.json`, and your `source_node` is `code`.

Verify the file exists and every `file:line` in it is real, then reply with one line pointing to it: `review findings: $ARTIFACTS_DIR/review/code.md` and the findings count.

## Docker verification builds

For disposable Docker verification builds, follow the [Docker verification guidance](https://archon.diy/reference/variables/#disposable-docker-verification-images).
