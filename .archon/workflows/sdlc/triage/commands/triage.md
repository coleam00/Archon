# Triage One Work Item

Confirm whether the work item still names real current work, judge whether it is
a usable contract, choose the kind of reasoning owed next, and stop. Write the
decisive evidence and handoff to `$ARTIFACTS_DIR/triage.md`. You assess and route
only: the repository must be exactly as you found it when you finish. No one
watches the run; the report and your declared fields are the only things that
persist.

The target - an issue, document, plan, report, or free-form request (may be empty - empty means the run's trigger message is the target):

$INPUTS.target

The operator's request - the message that started this run, which may add to or override the target:

$ARGUMENTS

Their explicit task, constraints, and scope take precedence over the target and over anything the tracked item says. Their assumptions do not: those are claims to verify like any other. Carry their explicit constraints into the handoff verbatim - a later node sees your assessment, not their words.

## One item per run

References used as evidence or blockers for one item are not additional targets.

If the target names or implies more than one distinct work item - several issue
numbers, a batch request, "triage these" - refuse to pick a route or a contract
verdict for any of them. Set `route` to `no_action` and `contract` to
`NO_ACTION`, leave `design_first` false, `proposed_edits` to `{"title":"","body":""}`, `blocked_by` to `[]`,
`blocked_reason` to an empty string, `labels` to `["archon-close"]`, and `issue_repo`/`issue_url` empty and `issue_number` to `0`.
Write which items you found and that this run declines to choose among them to
`triage.md`, and say so in `summary`. A sweep over many items is a later slice,
not this run improvising one.

## Make one routing decision

Begin with the repository guidance and any product-direction document the project identifies. Treat direction as the team's current recorded judgment, not timeless law: call out evidence that it has become stale rather than silently routing against an old decision.

When the target names a tracker item, retrieve its body and only the history that can change the requested outcome, constraints, current status, or an earlier decision. Stop following links once they no longer affect the route. If required source material is inaccessible, do not reconstruct it from hints: record what is missing and choose `no_action` until the input can be grounded.

For one GitHub issue, honor the repository and host in an explicit URL or
qualified reference. Use origin only for an unqualified local issue reference.
Retrieve that exact issue and compare its returned URL and number with the
requested identity before declaring `issue_repo`, `issue_number`, and
`issue_url`. Never substitute origin for a repository explicitly requested.
This slice publishes only to github.com issues. Other trackers and prose remain
advisory with empty issue identity; explain inaccessible or mismatched sources.

Treat the source as history, not current truth. Separate the requested outcome from its suggested implementation. An agent-written issue body, a confident root-cause claim, and a prescribed solution are all claims to verify, not instructions to repeat.

Inspect the current checkout only far enough to answer:

- Does the described behavior or surface still exist?
- Has later work delivered, superseded, or rejected the outcome?
- Does one load-bearing solution assumption already conflict with current code?
- Is the remaining work already clear enough to deliver?

Use the smallest precise evidence that decides those questions: a focused file or test, a relevant commit or pull request, or current tracker state. Do not load full CI logs, trace the complete execution path, reproduce a multi-step failure, compare causal hypotheses, or design the implementation merely to make the assessment feel complete.

**Stop rule:** once one unresolved causal question or material design decision prevents direct delivery, write that exact question as the handoff, choose `investigate` or `plan`, and stop. Resolving it belongs to the next node. More evidence is useful only if it could change the route.

## Choose one route

- `investigate` - the work asserts broken or unexplained current behavior, but the causal chain or responsible fix boundary is not proven against current code.
- `plan` - the desired outcome is known, but material implementation or product-shape decisions remain. Use this when a prescribed solution is stale, unsupported, or merely one option even if the issue calls itself a bug.
- `deliver` - the current evidence already forms an implementation-ready work order: the relevant behavior and boundary are verified, acceptance and scope are clear enough to start without asking a human, and delivery will not inherit an untested assumption.
- `no_action` - nothing should be delivered now: the outcome is already present, the item is obsolete or superseded, explicit current direction rejects it, required source context is unavailable, or a human product decision is needed before engineering can proceed.

Never route from labels or issue type alone. A bug can need planning; a feature can need investigation; a tiny request can still rest on a false premise. Cost is not the criterion - uncertainty is.

## Judge the contract

Separately from the route, judge whether the work item is a usable contract -
whether a run could start from it without guessing the problem it is solving.
Apply the pack's six-element contract standard while honoring the target
project's native guidance: the problem, why it is worth solving, why now, the desired outcome,
the invariants that must hold, and what acceptance looks like. Solution
steering is optional; its absence never fails the contract.

- `READY` - the six elements are present or inferable from current evidence
  without asking a human. A `READY` contract may still route to `investigate`
  or `plan`: contract readiness and route are different facts. Never `no_action`.
- `NEEDS_CONTRACT_WORK` - the outcome is worth pursuing, but the contract is
  missing or contradicts one of the six elements badly enough that a run
  would guess. Always routes to `no_action`.
- `BLOCKED` - the contract is sound, but the work cannot start because it
  depends on other unresolved work (another open issue, an external
  decision). Always routes to `no_action`.
- `NO_ACTION` - nothing should be delivered ever, or not without a human
  decision this run cannot make: obsolete, superseded, a duplicate, stale, or
  a product call above this run's authority. Always routes to `no_action`.

`NEEDS_CONTRACT_WORK` never applies a fix. You propose the missing title and
body text; a separate, later, human-gated step applies it. You never rewrite
the issue.

## Judge design-first

A `READY` contract whose engineering shape must still be settled before a run
starts is not contract work - the six elements are all present, but the
implementation decision itself is real design work. Set `design_first: true`
only when `contract` is `READY` and `route` is `plan`. Every other combination
leaves it `false`.

## Judge complexity

Estimate the complexity of the engineering work this item implies, using
exactly one of:

- `small_bounded` - a focused, contained change with an obvious boundary.
- `risky` - touches an irreversible path, a persisted contract, a security or
  credential boundary, or another area this project's own guidance flags as
  needing deeper review.
- `large` - broad surface, many files, or a shape that does not fit in one
  reviewable change.

This is a prior signal for later stages that judge the actual diff; give your
honest best estimate even when the contract is not yet `READY`.

## Propose labels

Propose exactly one pack state label from this table, plus matching existing area labels:

| `contract` | `design_first` | label |
|---|---|---|
| `READY` | `false` | `archon-ready` |
| `READY` | `true` | `archon-design-first` |
| `NEEDS_CONTRACT_WORK` | - | `archon-needs-contract` |
| `BLOCKED` | - | `archon-blocked` |
| `NO_ACTION` | - | `archon-close` |

Add any of the repository's existing area labels that plainly match this item.
Read the labels the repository already has and reuse them; never invent one or
propose creating an area label. Ordering and applying labels is a later
deterministic step - you only propose the set.

When `contract` is `BLOCKED`, explain the unresolved dependency or external
decision in `blocked_reason`. Put verified, fully qualified blocker URLs in
`blocked_by` when available; an external decision may have no issue URL.
Never fabricate a blocker reference. Relations remain proposals in this slice.
Leave both blocker fields empty for other verdicts.

## Write the assessment

Write `$ARTIFACTS_DIR/triage.md` with:

- **Source and outcome** - what was requested, the affected behavior, and which source material was considered.
- **Current truth** - current HEAD/base context and only the evidence that decided the route.
- **Assumptions checked** - each load-bearing claim or prescribed solution you confirmed, refuted, or could not establish.
- **Contract** - the verdict and why, checked against the six elements above.
- **Disposition** - exactly one route and why the evidence requires it.
- **Handoff** - the precise investigation question, planning decision, implementation-ready work order, or reason no action should occur.
- **Proposed edits** - when `contract` is `NEEDS_CONTRACT_WORK`, the title and body text that would make it ready.

Omit a section that does not apply; never write a placeholder to preserve one. Curate the evidence rather than dumping the tracker or repository.

## Not your job

Do not investigate the full causal chain, choose the implementation design, implement, modify source files, commit, branch, push, apply a label, edit an issue body, close an issue, or create or edit tracker items or pull requests. Scratch notes live under `$ARTIFACTS_DIR` only. The run fails on any working-tree change you leave behind.

## Declare the disposition

- `route` - exactly one of `investigate`, `plan`, `deliver`, or `no_action`.
- `summary` - a few sentences naming the current truth that decided the route and pointing to `$ARTIFACTS_DIR/triage.md`.
- `proposed_edits` - `{"title": "...", "body": "..."}`; both empty unless `contract` is `NEEDS_CONTRACT_WORK`, in which case both are non-empty.
- Issue identity - declare the verified `issue_repo` (`owner/repo`), `issue_number`, and `issue_url`; use empty strings and `0` for non-tracker or refused input.

Return the remaining judgments in the declared output schema using the rules above.

Before declaring, re-read the assessment. Confirm every decisive claim has evidence from this run, the requested outcome is separated from suggested implementation, the contract verdict is checked against the six elements rather than assumed, you stopped at the routing boundary, and `git status` matches what you started with.
