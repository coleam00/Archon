# Triage One Work Item

Establish what the work item means against the repository as it exists now, then choose the least speculative next step. Write the evidence and handoff to `$ARTIFACTS_DIR/triage.md`. You assess and route only: the repository must be exactly as you found it when you finish.

The target — an issue, document, plan, report, or free-form request (may be empty — empty means the run's trigger message is the target):

$INPUTS.target

The run's trigger message, which may add or override context:

$ARGUMENTS

## Resolve the complete source

Begin with the repository guidance and any product-direction document the project identifies. Treat direction as the team's current recorded judgment, not timeless law: honor explicit freshness rules, and call out evidence that it has become stale rather than silently routing against an old decision.

When the target names a tracker item, retrieve the body and the decision-relevant history with the available tracker CLI. Read comments, linked issues or pull requests, specifications, plans, and attachments when they can change the intended outcome, constraints, current status, or earlier decisions. Stop following links once they no longer affect this work item. If required source material is inaccessible, do not reconstruct it from hints: record what is missing and choose `no_action` until the input can be grounded.

Treat the source as history, not current truth. Separate the requested outcome from its suggested implementation. An agent-written issue body, a confident root-cause claim, and a prescribed solution are all claims to verify, not instructions to repeat.

## Confirm the shape against current reality

Inspect the current checkout before choosing a route. Record the current HEAD and the target/base branch when it can be established without changing branches. Check only as far as needed to make the routing decision:

- Does the described behavior, surface, file, or constraint still exist?
- Has later work already delivered the outcome, made it obsolete, or replaced it with a different direction?
- Do the issue's load-bearing claims and solution assumptions agree with the current code and tests?
- Is the desired outcome still clear when those implementation assumptions are removed?
- Is there a current plan or investigation whose decisive claims still hold?

Use precise repository evidence: files and stable anchors, focused commands and their observed results, relevant tests, commits, or current tracker state. Do not do a full root-cause investigation or write an implementation plan here. When proving a cause or choosing a design would require deeper work, that is the routing answer.

## Choose one route

- `investigate` — the work asserts broken or unexplained current behavior, but the causal chain or responsible fix boundary is not proven against current code.
- `plan` — the desired outcome is known, but material implementation or product-shape decisions remain. Use this when a prescribed solution is stale, unsupported, or merely one option even if the issue calls itself a bug.
- `deliver` — the current evidence already forms an implementation-ready work order: the relevant behavior and boundary are verified, acceptance and scope are clear enough to start without asking a human, no material causal or design decision remains, and delivery will not inherit an untested assumption.
- `no_action` — nothing should be delivered now: the outcome is already present, the item is obsolete or superseded, explicit current direction rejects it, required source context is unavailable, or a human product decision is needed before engineering can proceed.

Never route from labels or issue type alone. A bug can need planning; a feature can need investigation; a tiny request can still rest on a false premise. Cost is not the criterion — uncertainty is.

## Write the assessment

Write `$ARTIFACTS_DIR/triage.md` with:

- **Source and outcome** — what was requested, the affected behavior, and which source material was considered.
- **Current truth** — current HEAD/base context and the decisive present-day evidence.
- **Assumptions checked** — each load-bearing claim or prescribed solution you confirmed, refuted, or could not establish.
- **Disposition** — exactly one route and why the evidence requires it.
- **Handoff** — the precise investigation question, planning decision, implementation-ready work order, or reason no action should occur.

Omit a section that does not apply; never write a placeholder to preserve one. Curate the evidence rather than dumping the tracker or repository.

## Not your job

Do not investigate the full causal chain, choose the implementation design, implement, modify source files, commit, branch, push, or create or edit tracker items or pull requests. Scratch notes live under `$ARTIFACTS_DIR` only. The run fails on any working-tree change you leave behind.

## Declare the disposition

- `route` — exactly one of `investigate`, `plan`, `deliver`, or `no_action`, using the definitions above.
- `summary` — a few sentences naming the current truth that decided the route and pointing to `$ARTIFACTS_DIR/triage.md`.

Before declaring, re-read the assessment. Confirm every decisive claim has evidence from this run, the requested outcome is separated from suggested implementation, the handoff contains no decision assigned to the next stage that this route was supposed to settle, and `git status` matches what you started with.
