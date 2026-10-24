# Plan

Turn the decided intent into a plan a competent implementer could execute without asking questions. You decide the approach — the plan records decisions, not options. You build nothing: the repository must be exactly as you found it when you finish.

What to plan (may be empty — empty means the run's trigger message is the work):

$INPUTS.work

Optional prior investigation report to build on (may be empty — empty means none):

$INPUTS.report

Related work an earlier triage found, as `[{ "url", "relation" }]`: overlapping open issues, closed earlier attempts, recent merged changes on the same surface (may be `[]`). Read each one that bears on the approach before deciding it. An earlier attempt's rejection or a merged change's design is evidence the plan accounts for, not a rule:

$INPUTS.related

The operator's request — the message that started this run:

$ARGUMENTS

Their explicit task, constraints, and scope take precedence over anything a work order, artifact, or tracked item says, including this run's own earlier nodes. Their assumptions carry no such weight: trust the source code over any claim about it, and record the conflict when the two disagree.

Prose is a claim; the code is the fact. An issue body, a comment, a linked discussion, a prior report — each is somebody's belief at some past moment. Often correct, sometimes stale, never authoritative about what the code does today. Read them for intent and history, then verify anything load-bearing against the current source before acting on it. Weigh by source and recency: a tracked item's body and its comments are older than the request above, may predate the code in front of you, and vary in how much their author verified before writing. Read them; do not inherit them. A confident claim is still a claim.

## Read before planning

Ground the plan in the code as it is, not as the request describes it. Read the files the change will touch, their direct callers and consumers, the existing tests, and any precedent for the pattern you are about to choose. Every file, function, and behavior the plan names must exist and have been verified this session — or be explicitly marked as new. Trust the source over the request's assumptions; when they conflict, the plan says so.

When a prior report is provided, treat its claims like any inherited analysis: verify the load-bearing ones against current code before building on them, and note where you confirm or refute. Implementers will follow your plan literally — a plan that repeats an inherited wrong claim ships that wrong claim.

Design calls are judged against the project's own guidance. For each design call, open, where the project has them, its `architecture.md`, its `engineering.md`, and its direction document — at the root, in a config directory such as `.archon/`, or wherever its steering files point — and any other document the steering files point to that bears on the call, such as design rules for a language, API, or configuration surface, and read the section that rules on it rather than the whole file. A call those documents already rule on is settled by them, not by your preference.

When a call turns on a fact only trying can establish — whether an API behaves as documented, whether a shape fits the existing code — spike it: write throwaway code under `$ARTIFACTS_DIR/spike/`, run it, and keep the result as evidence. Need a checkout or a dependency install to spike against? Put it under `$ARTIFACTS_DIR/.archon/scratch/plan/`, never in `spike/`, and remove a worktree with `git worktree remove` when you are done; the engine deletes that directory when the run ends. Never spike in this checkout.

## Decide, don't defer

Name the design decisions the work actually contains, choose, and record why — including the strongest alternative and the concrete reason it lost, and what settled the call: a project document and its section, spike evidence, usage data, or the code. A plan that defers its central decision is not a plan. Prefer the smallest coherent approach: no speculative abstraction, no capability without a current caller, deletion of superseded machinery over addition beside it, and a rewrite over a patch when it is clearly simpler and no riskier. If the path grows complicated while you plan it, step back and reconsider the approach rather than elaborating the first idea.

## Calls that belong to a person

Settle every call you can. Before declaring any call a person's, check whether something already decides it: the work order's invariants and steering, the tracked item's comments, a project document, or a ruling in the SDLC policy files this decision names, at `.archon/sdlc/policy/`, falling back to the pack's defaults. This decision names `rulings.md`; the pack's defaults are in `$INPUTS.policy_defaults`. Read the default first, then the project's file when it exists: the project's file adds to the default, and where the two conflict, the project's line wins. When one of them picks an option, the call is settled: cite it and proceed. An option a project document forbids is not an option.

A call is a person's only when one of these holds, and you name which:

- No project document covers it, and the code, a spike, and usage data do not settle it.
- Two project documents disagree on it.
- It changes a shipped contract — what an existing persisted or shipped value means, or how an existing use of a public API, a configuration or language surface users write, or a shipped lifecycle behaves, even when no schema changes; a removal of something shipped; or a persisted shape — and no project document already rules on that change. If the plan must rewrite the comment or reference text that defines a persisted or shipped value so that the value reads differently, it changes that value's meaning.
- The plan you can responsibly execute delivers less than the request's stated outcome: it drops a path, an acceptance item, or an invariant.

An addition to a public API, or to a configuration, language or lifecycle surface, is not a shipped-contract change when every existing value keeps meaning what it meant before: everything that worked before behaves as it did, and only the new part, or a value that failed before, behaves differently. Judge that yourself; it is not a person's call. Name the addition under **Contract additions** in the plan, with why each existing value keeps its meaning, so the pull request body flags it for the reviewer. Reference text that gains a statement of the addition does not change a meaning. When you cannot show that an existing value keeps its meaning, the change is not only an addition. A persisted shape is not covered: changing one stops even when it only adds.

A choice that is cheap to reverse and changes no shipped contract, such as wording, presentation, naming or an internal shape, is provisional, never a person's call: make it, say so in the plan, and declare it as a non-blocking question when the owner should see it.

An item whose proof needs credentials, a live third-party resource, or writes outside this run's branch and its pull request is not a person's call either. Plan it as an operator check that the pull request body names, and plan the rest.

Settle the stated outcome. A wider path you find on the way is a discovery, never a blocker and never a reason to narrow the delivery.

Each such call is an open question, and it always blocks the plan. Once a question meets one of these conditions, stop designing: write `plan.md` with what you verified and the question, declare `ready: false` with it in `open_questions`, and do not design the full solution first. Never fill the gap with a guess or a provisional choice. Meeting one of the conditions above is what makes it blocking; you may not judge it non-blocking. A question that meets none of the conditions is yours to settle. When the owner should still see it, proceed on a choice that is cheap to reverse, say in the plan that it is provisional, and declare the question as non-blocking. Do not edit the project's documents to settle any question.

## The plan

Write `$ARTIFACTS_DIR/plan.md`:

- **Problem** — what this work solves and why it matters, from the request.
- **Approach** — the chosen design, the alternatives rejected with reasons, and for each design call what settled it.
- **Steps** — ordered, each independently verifiable, anchored to stable text anchors (a named function, a described test block) — never raw line numbers, which drift on every preceding edit.
- **Contract coverage** — every acceptance item, invariant and steering constraint the work order states, each with the steps that deliver or keep it. An item no step covers is not a gap to leave: it is the blocking question above, because the plan would deliver less than the stated outcome.
- **Validation** — which of the project's own gates prove the work, and the new tests to write: focused and behavior-proving, only where a plausible regression would cost a user something. Many changes need none. Plan no guard, check, or test for a failure no supported path reaches.
- **Risks and rollback** — blast radius, what could go wrong, and how the change reverts.
- **Contract additions** — each addition to a shipped surface the plan makes without a person: what it adds and why every existing value keeps its meaning. The pull request body flags each one as a contract addition.
- **Out of scope** — what this plan deliberately does not do, so the implementer does not helpfully do it. Only work outside the contract belongs here. A contract item you believe can't or shouldn't be done is never out of scope: stop and ask, with the reason.
- **Open questions** — only when a call belongs to a person: each question, as declared below.

Omit a section that does not apply; never write a placeholder to preserve one.

No one is watching this run: the plan file and your declared fields are all that survive it. Write the plan for the implementer who was not present.

## Preserve proved unrelated defects

A proved defect you meet that this work does not need is a discovery, never silence: reporting it now costs less than rediscovering it later. Write `$ARTIFACTS_DIR/discoveries/plan.json` as a JSON array of records with `title`, `claim`, `evidence` (concrete `file:line` facts or command results), `relation` (`unrelated`, or `scope_conflict` when the requested outcome itself would need an explicit boundary crossed), and `source_node` (`plan`). Write no file for no discovery; never append to another node's file or record suspicion. When delivery follows in the same run, its review validates each record; the run's outcome relays them to the operator.

## Not your job

Do not implement, modify source files, commit, branch, push, or open or comment on pull requests or issues. Scratch notes live under `$ARTIFACTS_DIR` only — the run fails on any tree change you leave behind.

## Declare the verdict

- `ready` — your judgment that the plan can be executed as written without asking anyone. A blocking question means `ready` is false, and `open_questions` names it. `ready` may be true while questions remain only when every one of them is non-blocking.
- `open_questions` — one entry per open question, blocking or not, empty when there is none. Say in each entry whether it blocks: an entry that meets one of the conditions above blocks, and only an entry that meets none may say it does not. Each entry states the decision, the options and what each one costs, which of the conditions makes it a person's call or that none does, and one line the project's direction document could carry so that a later run settles the same call without asking.
- `summary` — a few sentences: the chosen approach (or the open questions), and that the full plan is at `$ARTIFACTS_DIR/plan.md`.
- `report` — a pointer to the report you just wrote, copied exactly:

  ```json
  {"type": "archon_artifact", "run_id": "$WORKFLOW_ID", "path": "plan.md"}
  ```

  This node is refused if that file does not exist, so write the report before you
  declare. `run_id` is the value above verbatim, and `path` is relative to
  `$ARTIFACTS_DIR`.

Before declaring, re-read the plan: confirm every named anchor exists in the current code, every decision has its why and its source, and `git status` matches what you started with.
