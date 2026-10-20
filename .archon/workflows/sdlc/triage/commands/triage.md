# Triage One Work Item

Confirm whether the work item still names real current work, judge whether it is a contract a run can start from, choose the kind of reasoning owed next, and stop. Write the decisive evidence and handoff to `$ARTIFACTS_DIR/triage.md`. You assess and route only: the repository must be exactly as you found it when you finish. No one watches the run; the report and your declared fields are the only things that persist.

The target — an issue, document, plan, report, or free-form request (may be empty — empty means the run's trigger message is the target):

$INPUTS.target

The operator's request — the message that started this run, which may add to or override the target:

$ARGUMENTS

Their explicit task, constraints, and scope take precedence over the target and over anything the tracked item says. Their assumptions do not: those are claims to verify like any other. Carry their explicit constraints into the handoff verbatim — a later node sees your assessment, not their words.

## Make one routing decision

Begin by reading, where the project has one, its direction document — at the root, in a config directory such as `.archon/`, or wherever its steering files point — and the SDLC policy files this decision names, at `.archon/sdlc/policy/`, falling back to the pack's defaults. This decision names `triage.md`; the pack's defaults are in `$INPUTS.policy_defaults`. Read the default first, then the project's file when it exists: the project's file adds to the default, and where the two conflict, the project's line wins. Open its `architecture.md` only when whether the requested approach fits the codebase depends on it, and read the section that rules on it. Treat direction as the team's current recorded judgment, not timeless law: call out evidence that it has become stale rather than silently routing against an old decision.

When the target names a tracker item, retrieve its body and all of its comments. Comments are context: they can carry a reproduction, a narrowed ask, or a decision in discussion. A dated "Current scope" section in the body is the authority for a ruling, and a comment that contradicts it is a question to report, not a ruling to follow. For material the item links to, follow only what can change the requested outcome, constraints, current status, or an earlier decision, and stop following links once they no longer affect the route. If required source material is inaccessible, do not reconstruct it from hints: record what is missing and declare `BLOCKED` until the input can be grounded.

Treat the source as history, not current truth. Separate the requested outcome from its suggested implementation. An agent-written issue body, a confident root-cause claim, and a prescribed solution are all claims to verify, not instructions to repeat.

Inspect the current checkout only far enough to answer:

- Does the described behavior or surface still exist?
- Has later work delivered, superseded, or rejected the outcome?
- Does another open issue already track this outcome? Search the tracker and read any candidate issue with its comments before choosing a verdict. Note what the search turns up that overlaps without duplicating, along with closed earlier attempts and recent merged changes on the same surface: they go in `related`.
- Does one load-bearing solution assumption already conflict with current code?
- Is the remaining work already clear enough to deliver?

Use the smallest precise evidence that decides those questions: a focused file or test, a relevant commit or pull request, or current tracker state. Do not load full CI logs, trace the complete execution path, reproduce a multi-step failure, compare causal hypotheses, or design the implementation merely to make the assessment feel complete.

**Stop rule:** once one unresolved causal question or material design decision prevents direct delivery, write that exact question as the handoff, choose `investigate` or `plan`, and stop. Resolving it belongs to the next node. More evidence is useful only if it could change the route.

## Judge the contract

A run cannot recover from a premise that was never stated, so before choosing a route decide whether the item is a contract at all. It must communicate six things, semantically rather than by heading: the **problem** (what is wrong or missing today), **why** it is worth solving, **why now**, the **outcome** (what should become observably true), the **invariants** that must hold, and **acceptance** (how completed behavior will be recognized). Infer them from the complete source; do not invent product intent. Solution steering is optional, and its absence never fails the contract. Root cause, design, file paths, and test commands are not required — the next node owns those.

Then check the delivery preconditions the outcome actually depends on: an existing primitive or owner, a data shape or typed seam, a persistence model, the observability needed to verify the result. A refactor of code the work must already touch is issue-owned enabling work, not a blocker. A missing foundation with its own outcome, broader owners, or a separate product decision is a prerequisite that must land first — report it with the same weight whether or not anyone has logged it. Treat alignment with current direction as part of readiness.

The verdict says whether a run should start from this item, not only whether the item is well written. A well-formed contract whose outcome already holds on the current base is never `READY`: it is `NO_ACTION`, or `BLOCKED` when the policy leaves its close to a maintainer.

Declare exactly one contract verdict:

- `READY` — the six elements are present and agree with each other and with current direction, the outcome is not already true on the current base, and the repository has a coherent place for the change, including any enabling work this item owns. This does not claim the solution is designed.
- `NEEDS_CONTRACT_WORK` — one of the six elements is materially missing, ambiguous, or contradictory. Propose the contract that would make the item ready (below) and stop.
- `BLOCKED` — the contract is clear, but something must happen first: a prerequisite that has its own owner, an owner-level product decision, source material that cannot be reached, direction that looks stale and needs a maintainer's judgment, or a close the triage policy leaves to a maintainer. Name what it waits on in `blocked_reason`, and list the fully qualified URLs of the items it waits on in `blocked_by` when they exist; an external decision may have none. Never invent a reference.
- `NO_ACTION` — the item should be closed, and the triage policy allows that close without a person. Two reasons can close an item this way, and each only when the policy allows it: the item duplicates another open issue, or a merged change already delivered its outcome. For a delivered close, read the merged change's diff and verify that it delivers the item's outcome on the current base, then cite that change in `closure`. An open pull request that already carries the outcome is `READY` with route `continue`, not a duplicate. Whether the policy allows it is the policy's call, not this command's. Name that item or change in `closure` by the URL you opened to confirm it; never invent one. An item that looks closable for any other reason, or for one the policy leaves to a maintainer, is `BLOCKED` instead, with `blocked_reason` naming the maintainer's decision and why the item looks closable.

Only a `READY` item carries an engineering route, and a `READY` item always carries one. Every other verdict carries no route: the verdict is the reason, and the route you would have chosen belongs in the assessment for the human, not in the declared fields.

## Judge the item's fields

Declare five fields on the item as written, each one value and a one-line `reason` grounded in what you read. Judge them against the project's own documents and the code, not the item's own claims: an issue that calls itself urgent is evidence to weigh, not the answer.

- `type` — what kind of work the item asks for: `bug` (something that worked or is documented to work is broken), `feature` (new behavior), `refactor` (the same behavior, better structure), `maintenance` (dependencies, tooling, CI, upkeep), `docs` (documentation only), or `question` (a person must answer; no change is asked for yet).
- `size` — how much changes: `s` a few files on one surface, `m` several files or two surfaces, `l` several packages, schemas, or surfaces.
- `complexity` — how many unknowns and how much design risk, separate from size: `low` the change is clear, `medium` it touches authentication, persisted data, a destructive path, or a compatibility boundary, or crosses packages in a way a reviewer must think about, `high` it holds a shape decision the item does not settle. A one-line change to authentication is `s` and `medium` or `high`.
- `importance` — how much the outcome matters against the project's direction: `low`, `medium`, or `high`. This is not priority.
- `urgency` — how time-sensitive it is: `now` for a regression, a security issue, or work that blocks other work or a release; `soon` when it should land before the next release; otherwise `none`.

Never derive a priority; the queue that picks the item orders it from these fields.

## Choose one route

- `investigate` — the work asserts broken or unexplained current behavior, but the causal chain or responsible fix boundary is not proven against current code.
- `plan` — the desired outcome is known, but material implementation or product-shape decisions remain. Use this when a prescribed solution is stale, unsupported, or merely one option even if the issue calls itself a bug. A design call that may need a person is still `plan`: the planner settles it from the project's own documents, code, and evidence, and stops with the exact question only when those cannot. When you route `plan`, do not declare that the item holds no decision a person must make; that judgment is the planner's. An owner-level product decision the item cannot proceed without is `BLOCKED`, not `plan`.
- `deliver` — the current evidence already forms an implementation-ready work order: the relevant behavior and boundary are verified, acceptance and scope are clear enough to start without asking a human, and delivery will not inherit an untested assumption.
- `continue` — an open pull request already carries this outcome, because the operator names one to continue or you find one: the run finishes that pull request instead of opening another. Name it in `pull_request`. A pull request from a fork whose author did not allow maintainer edits cannot be continued by this run: that item is `BLOCKED` on it.

Never route from labels or issue type alone. A bug can need planning; a feature can need investigation; a tiny request can still rest on a false premise. Cost is not the criterion — uncertainty is. `type` and `size` do not choose among `investigate`, `plan`, and `deliver`.

## Labels

The workflow derives the pack's own labels from your declared fields, exactly one state label and one type label per item, and a size label while the item can still be worked; you do not choose those. You choose only area labels, and only from labels the repository already has (use `archon forge repo.labels.list` with the qualified repository, through the argv in `$ARCHON_CLI_COMMAND`, or `gh label list` when the run selected `ARCHON_SDLC_FORGE=gh`): declare the ones that name the areas this item touches, or none. Never invent a label. Nothing is written unless the run was launched with `publish` true; either way the run records what it would apply.

When the target is a tracker issue, declare `item` as its qualified repository (`repo: {host, path}`) and number so the workflow can address it; the workflow verifies that identity against the tracker before it writes. Otherwise declare `item: {repo: {host: "", path: ""}, number: 0}`.

## Write the assessment

Write `$ARTIFACTS_DIR/triage.md`. Title it `# Triage: owner/repo#N — <item title>` for a tracker issue, otherwise `# Triage: <the request in a few words>`. Cite code by repository-relative path and line; the checkout you read is temporary and its absolute path is dead once the run ends. Sections:

- **Source and outcome** — what was requested, the affected behavior, which source material was considered, and which triage policy applied: the pack's default, plus the project's `.archon/sdlc/policy/triage.md` when it exists, naming any project line that overrode the default.
- **Current truth** — current HEAD/base context and only the evidence that decided the route.
- **Assumptions checked** — each load-bearing claim or prescribed solution you confirmed, refuted, or could not establish.
- **Contract** — the verdict, which of the six elements are present or missing, the preconditions checked, and any prerequisite found. When the verdict is `READY`, quote the source's invariants, acceptance items, and any solution steering here, each item as the source words it. Later steps plan, implement, and review against this section, and an item you only count or summarize is one they cannot check.
- **Disposition** — exactly one route and why the evidence requires it. When the verdict is not `READY`, name here the route the item would take once it is.
- **Proposed contract** — only for `NEEDS_CONTRACT_WORK`: the title and body you declare in `proposed_edits`, in the repository's issue template shape when one exists, with only the context that constrains the work. Propose; never apply. A later gated step owns the edit.
- **Handoff** — the precise investigation question, planning decision, implementation-ready work order, the pull request to continue, or the reason no action should occur. State an open decision as a question; never name a mechanism, data structure, or protocol as the answer — the next node designs it, and a mechanism named here becomes the contract every later node builds.

Omit a section that does not apply; never write a placeholder to preserve one. Curate the evidence rather than dumping the tracker or repository.

## Not your job

Do not investigate the full causal chain, choose the implementation design, implement, modify source files, commit, branch, push, or create or edit tracker items, labels, or pull requests. Scratch notes live under `$ARTIFACTS_DIR` only. The run fails on any working-tree change you leave behind.

## Declare the disposition

- `decision` — the contract verdict and only what it carries, using the definitions above:
  - `READY` with `route` `investigate`, `plan`, or `deliver`;
  - `READY` with `route` `continue` and `pull_request` — the number of the open pull request to finish, in the item's repository;
  - `NEEDS_CONTRACT_WORK` with `proposed_edits` — `{ "title", "body" }`, both non-empty;
  - `BLOCKED` with `blocked_reason` — what it waits on — and `blocked_by` — fully qualified URLs of the items it waits on, possibly empty;
  - `NO_ACTION` with `closure` — `{ "kind": "duplicate", "url", "original" }`, where `url` is the open issue's fully qualified URL and `original` is the same issue as `{ "repo": { "host", "path" }, "number" }`; or `{ "kind": "delivered", "url" }`, where `url` is the merged change's fully qualified URL.
- `type`, `size`, `complexity`, `importance`, `urgency` — each `{ "value", "reason" }`, the value from its list above and the reason one non-empty line.
- `item` — `{ "repo": { "host": "tracker.example", "path": "owner/repo" }, "number": N }` when the target is a tracker issue, otherwise `{ "repo": { "host": "", "path": "" }, "number": 0 }`: the empty repository is how you say the target is not a tracker item, and the fields are always present.
- `area_labels` — the repository's existing area labels this item touches, possibly empty.
- `related` — work the next node should know about, each `{ "url", "relation" }`: an open issue whose outcome overlaps this one, a closed earlier attempt or rejected design, or a recently merged pull request on the same surface. `url` is the fully qualified URL of an item you opened in this run, and `relation` is one line on how it bears on this item. List only what you opened; empty when there is none. Duplicates and blockers belong in `decision`, not here.
- `summary` — a few sentences naming the verdict, the current truth that decided the route, and pointing to `$ARTIFACTS_DIR/triage.md`.
- `report` — a pointer to the report you just wrote, copied exactly:

  ```json
  {"type": "archon_artifact", "run_id": "$WORKFLOW_ID", "path": "triage.md"}
  ```

  This node is refused if that file does not exist or is empty, so write the report
  before you declare. `run_id` is the value above verbatim, and `path` is relative to
  `$ARTIFACTS_DIR`.

Before declaring, re-read the assessment. Confirm every decisive claim has evidence from this run, the requested outcome is separated from suggested implementation, you stopped at the routing boundary, and `git status` matches what you started with.
