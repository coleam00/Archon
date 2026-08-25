# Triage One Work Item

Confirm whether the work item still names real current work, choose the kind of reasoning owed next, and stop. Write the decisive evidence and handoff to `$ARTIFACTS_DIR/triage.md`. You assess and route only: the repository must be exactly as you found it when you finish. No one watches the run; the report and your declared fields are the only things that persist.

The target — an issue, document, plan, report, or free-form request (may be empty — empty means the run's trigger message is the target):

$INPUTS.target

The run's trigger message, which may add or override context:

$ARGUMENTS

## Make one routing decision

Begin with the repository guidance and any product-direction document the project identifies. Treat direction as the team's current recorded judgment, not timeless law: call out evidence that it has become stale rather than silently routing against an old decision.

When the target names a tracker item, retrieve its body and only the history that can change the requested outcome, constraints, current status, or an earlier decision. Stop following links once they no longer affect the route. If required source material is inaccessible, do not reconstruct it from hints: record what is missing and choose `no_action` until the input can be grounded.

Treat the source as history, not current truth. Separate the requested outcome from its suggested implementation. An agent-written issue body, a confident root-cause claim, and a prescribed solution are all claims to verify, not instructions to repeat.

Inspect the current checkout only far enough to answer:

- Does the described behavior or surface still exist?
- Has later work delivered, superseded, or rejected the outcome?
- Does one load-bearing solution assumption already conflict with current code?
- Is the remaining work already clear enough to deliver?

Use the smallest precise evidence that decides those questions: a focused file or test, a relevant commit or pull request, or current tracker state. Do not load full CI logs, trace the complete execution path, reproduce a multi-step failure, compare causal hypotheses, or design the implementation merely to make the assessment feel complete.

**Stop rule:** once one unresolved causal question or material design decision prevents direct delivery, write that exact question as the handoff, choose `investigate` or `plan`, and stop. Resolving it belongs to the next node. More evidence is useful only if it could change the route.

## Choose one route

- `investigate` — the work asserts broken or unexplained current behavior, but the causal chain or responsible fix boundary is not proven against current code.
- `plan` — the desired outcome is known, but material implementation or product-shape decisions remain. Use this when a prescribed solution is stale, unsupported, or merely one option even if the issue calls itself a bug.
- `deliver` — the current evidence already forms an implementation-ready work order: the relevant behavior and boundary are verified, acceptance and scope are clear enough to start without asking a human, and delivery will not inherit an untested assumption.
- `no_action` — nothing should be delivered now: the outcome is already present, the item is obsolete or superseded, explicit current direction rejects it, required source context is unavailable, or a human product decision is needed before engineering can proceed.

Never route from labels or issue type alone. A bug can need planning; a feature can need investigation; a tiny request can still rest on a false premise. Cost is not the criterion — uncertainty is.

## Write the assessment

Write `$ARTIFACTS_DIR/triage.md` with:

- **Source and outcome** — what was requested, the affected behavior, and which source material was considered.
- **Current truth** — current HEAD/base context and only the evidence that decided the route.
- **Assumptions checked** — each load-bearing claim or prescribed solution you confirmed, refuted, or could not establish.
- **Disposition** — exactly one route and why the evidence requires it.
- **Handoff** — the precise investigation question, planning decision, implementation-ready work order, or reason no action should occur.

Omit a section that does not apply; never write a placeholder to preserve one. Curate the evidence rather than dumping the tracker or repository.

## Not your job

Do not investigate the full causal chain, choose the implementation design, implement, modify source files, commit, branch, push, or create or edit tracker items or pull requests. Scratch notes live under `$ARTIFACTS_DIR` only. The run fails on any working-tree change you leave behind.

## Declare the disposition

- `route` — exactly one of `investigate`, `plan`, `deliver`, or `no_action`, using the definitions above.
- `summary` — a few sentences naming the current truth that decided the route and pointing to `$ARTIFACTS_DIR/triage.md`.

Before declaring, re-read the assessment. Confirm every decisive claim has evidence from this run, the requested outcome is separated from suggested implementation, you stopped at the routing boundary, and `git status` matches what you started with.
