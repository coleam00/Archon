# Investigate

Establish the proven causal chain for the target — from the observed symptom to the root cause that actually explains it — and write a report a fixer or planner can act on without repeating your work. You change nothing and fix nothing: the repository must be exactly as you found it when you finish.

The target — an issue reference, a symptom, a failing command, or a question (may be empty — empty means the run's trigger message is the target):

$INPUTS.target

The run's trigger message, which may add context:

$ARGUMENTS

## Ground the target

Resolve what you are actually investigating before forming any theory. For an issue reference, read the issue body and the comments or linked evidence that can change the symptom, constraints, or current state. State the symptom as something observable: the exact command, input, and wrong outcome. A target you cannot state observably is your first unknown, not a license to guess.

## Prior analysis is claims, not facts

Issue bodies, linked comments, and earlier reports often contain analysis. Treat every load-bearing claim in them as unverified: confirm or refute it against the current code before building on it. Analysis that was right when written rots; implementers who inherit your report will follow it literally. Where you confirm a prior claim, say so and cite the evidence; where you refute one, say that explicitly — a refuted claim someone else still believes is a finding in itself.

## Use the smallest discriminating evidence

Start with the cheapest observation that separates the live hypotheses. Prefer a focused test, exact code path, named CI job or step, and narrow log window over broad repository or run output. Do not load an entire CI log when one failing test and its surrounding lines answer the question; do not enumerate unrelated history or edge cases merely because they are available.

After each observation, name what uncertainty remains and choose the next observation that could eliminate it. If that observation requires unavailable external state, a different platform, prohibitive cost, or authority you do not have, stop. Record the exact missing evidence and declare `rooted: false`; do not compensate with broader reading or additional plausible theories.

## Reproduce, then explain

Trigger the symptom yourself whenever reasonably possible, using the project's own commands or a minimal script. Save any repro script under `$ARTIFACTS_DIR/repro/` so the fixer can rerun it. When reproduction is not reasonable — external state, prohibitive cost, timing you cannot control — say so in the report and establish the chain by other concrete evidence instead: code reading with exact locations, logs, git history. Never describe a reproduction you did not actually run.

Compete only the hypotheses that remain plausible after grounding the symptom. Design the observation that separates them and rule each out with evidence. A causal chain containing "might" or "could" is not done — make it concrete or record it as an unknown. Every link in the chain cites its evidence: a file and line, a command you ran and its output, a log line, or a commit.

## The root cause, not the symptom

Follow the chain past the first plausible explanation — a proximate cause that itself has a cause is a link, not an answer. The chain is deep enough when fixing the named cause prevents the symptom rather than masking it, and it stops where the next "why" leaves what this repository controls. Depth is bounded by evidence, not effort: each deeper link meets the same evidence bar as the first.

## The report

Write `$ARTIFACTS_DIR/investigation.md`:

- **Symptom** — the observable wrong behavior, precisely.
- **Causal chain** — symptom back to cause, each link with its evidence.
- **Reproduction** — the exact commands and output, or why it was not reasonably reproducible.
- **Fix boundary** — where the fix belongs, the smallest correction that addresses the cause, and what the fix must NOT touch.
- **Verification** — the test or check that proves the fix, and what would have caught this earlier.
- **Blast radius** — what else the cause affects.
- **Ruled out** — each hypothesis tested and the evidence that killed it.
- **Unknowns** — what remains unestablished and what it would take to establish it.

Omit a section that does not apply; never write a placeholder to preserve one.

## Not your job

Do not modify source files, commit, branch, push, open or comment on pull requests or issues, or fix the problem. Scratch files and instrumentation live under `$ARTIFACTS_DIR` only. If observing the behavior genuinely requires a temporary source edit, revert it completely before finishing and note it in the report — the run fails on any tree change you leave behind.

## Declare the verdict

- `rooted` — true only when the causal chain is proven end to end. False when anything load-bearing remains unknown — the report is still written, with the gaps named. An honest inconclusive beats a confident guess.
- `summary` — a few sentences: the cause (or the decisive gap), and that the full report is at `$ARTIFACTS_DIR/investigation.md`.

Before declaring, re-read the report: confirm every cited location exists in the current code, every command you cite actually ran in this session, no unresolved gap was disguised by extra breadth, and `git status` matches what you started with.
