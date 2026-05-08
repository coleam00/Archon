# Archie v2 — PR Plan

**When to read this:** when actively shipping v2 work. This document is the ordered PR sequence for landing v2 improvements against the existing Archon pipeline. Companion to `ARCHIE_V2_BACKLOG.md` (the broader v2 enhancement list) and `ARCHIE_PRD.md` (the system-as-built spec).

Status: **PR 1 is starting now.** The remaining PRs stay deferred until PR 1
has run for at least one Epic-worth of tickets.

Rationale for not waiting: WOR-54 (the most recent ticket through the
pipeline) wasted four dev-loop attempts and ~55 minutes of compute on a
test/code coordination failure that a contract would have eliminated up
front. The cost of waiting is real and recurring; the cost of landing PR 1
is one Epic of slightly-changed wiring. Going.

---

## The core problem we are solving

The pipeline already produces correct work most of the time, but the most
expensive failures all share one root cause: **the test author and the
implementation author do not coordinate on the interface**. Examples from the
last 24 hours:

- **WOR-55 (solo mode):** test-gen wrote a stub returning `null`; dev-gen
  built the real hook returning `{all: [...]}`. Tests failed because they
  pointed at a stub the dev never updated. Both choices were plausible in
  isolation.
- **WOR-54 (closed case view):** test-gen wrote tests that import
  `<ClosedCaseView />` with zero props inside a `<Route>` — i.e. expecting
  a connected component. Dev-gen built `ClosedCaseView` as a presentational
  component requiring explicit array props. The two specs collided silently;
  the first two reviewers misdiagnosed the failure as a destructuring bug;
  attempt 3 finally identified the architectural mismatch. We paid four
  dev-loop iterations to recover from a coordination failure that no agent
  caused — neither was wrong, they just hadn't agreed on what they were
  building. Salvaged manually as PR #66 after another full set of test-mock
  fixes.
- **Test stub files as a workaround for the missing contract:** test-gen
  has been writing `__stubs__/<symbol>.ts` files that return placeholder
  values when the implementation doesn't exist yet. Multiple times the dev
  agent has not removed/replaced the stub, so tests pass against the stub
  forever (WOR-55 was the case we noticed). The stub pattern is a
  workaround for not having a contract that names the file the dev WILL
  create — with a contract, test-gen imports directly from the contracted
  path and the test runner returns a clean "module not found" until dev
  ships, which is the correct red state.

The fix is to make that interface decision **once, before either agent runs**,
and write it to a file both agents read.

That's the contract.

Everything else in the original spec doc (verdict schema, conflict domains,
retry classification, bug/feature flows) is nice-to-have. The contract is
the main lever. PR 1 below ships only that. Subsequent PRs are independent
and can be picked up in any order, or skipped.

---

## Constraints / ground rules

- No Jira project exists for Archon itself. Track this work via the PRs and
  this document; do not auto-file Archon tickets.
- The cage hook (script-based PreToolUse) is implemented and working — prompt
  rules are belt-and-suspenders, not the primary defense.
- Commands cannot compose. If a preamble is relevant to a command, duplicate
  the text into that command file.
- Information moves between nodes through **files on disk**, not env vars or
  `$node.output` substitutions. The contract is just another such file.
- Bug and feature-request workflows are separate functionality (PRs 6 and 7
  below); they can author their own bespoke commands as needed.
- Existing pipeline keeps running on `feature/jira-adapter` while these PRs
  ship. **PR 1's merge is the cutover point** — every newly-decomposed ticket
  after that lands goes through the contract path.

---

## PR 1 — Contract artifact (the main change)

**Why first and largest:** this is the only structural change to the graph
and the only PR that solves the coordination failures we have been seeing.
The rest of the improvements are independent of each other and of this one.

### What changes structurally

One new node, upstream of test-gen, in the existing `task-tests` workflow.
The rest of the DAG is unchanged.

```
Before:
  epic-decompose → (Jira ticket) → task-tests:
                                      └─ test-gen → commit → transition
                                  → task-implement (unchanged)

After:
  epic-decompose → (Jira ticket) → task-tests:
                                      ├─ contract-create   ← new node, writes
                                      │    │                  the contract artifact
                                      │    ▼
                                      └─ test-gen           ← reads the contract
                                          → commit → transition
                                  → task-implement:
                                      └─ dev-attempt-N      ← reads the contract
                                          (otherwise unchanged)
```

The contract lives on disk at `.archon/contracts/<issue-key>.md` in the
ticket's worktree. It is created by `contract-create`, read by every node
downstream that needs to know what is being built, and never modified after
creation. Same hook protection from accidental modification as test files.

### Phases inside `contract-create`

The node itself has clear internal phases (separate prompt sections, all
within the same Claude call unless we discover we need to split):

1. **Read inputs** — Jira ticket (user story + AC), parent epic context,
   any related already-merged tickets that touched the same files (for
   context, not for canonical signatures).
2. **Identify the interface surface** — files that will exist or change,
   exports, signatures, return types, where data flows in and out.
3. **State invariants** — privacy/security constraints, state-machine rules,
   read-only-ness, party isolation, etc., wherever they apply.
4. **Identify edge cases and non-goals** — what this ticket does NOT do, so
   the dev agent doesn't expand scope.
5. **Write the contract** — single markdown file with frontmatter for
   structured fields (file paths, exports, signatures) and prose for
   invariants and edge cases.

### Contract format

Markdown file with a YAML frontmatter block, then a body. Both the
frontmatter and the body are read by downstream agents — frontmatter is for
the unambiguous mechanical bits, body is for the prose that needs human-style
reading.

```markdown
---
task_id: WOR-54
ac_refs:
  - "Header shows case name, category, closure date, and outcome"
  - "Full joint chat transcript renders read-only (no input)"
  - "Tab navigation: Joint Chat | My Private Coaching | My Guidance"
  - "Other party's private coaching and synthesis are NEVER shown"
files:
  - path: src/pages/ClosedCasePage.tsx
    role: connected
    exports: [ClosedCaseView, ClosedCasePage]
  - path: src/components/ClosedCaseTabs.tsx
    role: presentational
    exports: [ClosedCaseTabs]
signatures:
  - "export function ClosedCaseView(): JSX.Element  // no props; calls useQuery internally"
  - "export interface ClosedCaseTabsProps { jointMessages: ...; privateMessages: ...; synthesisText: string | null }"
queries_used:
  - api.cases.get
  - api.jointChat.messages
  - api.privateCoaching.myMessages
  - api.jointChat.mySynthesis
read_only: true
tested_by:
  # Maps each AC ref to the test layer that verifies it. Helps the test
  # reviewer confirm coverage and flags ACs that rely on e2e-only verification
  # (where unit-test coverage % alone would be misleading because the
  # convex/react integration is mocked).
  - ac: "Header shows case name, category, closure date, and outcome"
    layer: unit
    file: tests/wor-54/closed-case-header.test.tsx
  - ac: "Other party's private coaching and synthesis are NEVER shown"
    layer: e2e
    file: e2e/wor-54/privacy-boundary.spec.ts
    reason: "Privacy enforcement is server-side via myMessages/mySynthesis queries — verifying it requires real Convex, not mocks."
---

## Invariants

- The connected view (`ClosedCaseView`) is what every consumer renders inside
  a `<Route>`. It takes no props and resolves data via Convex `useQuery` calls
  internally. Tests that render `<ClosedCaseView />` with zero props are
  testing the connected variant and must mock `useQuery`.
- The presentational variant exists only as `ClosedCaseTabs` and accepts
  explicit data props. It must never call `useQuery`.
- Privacy: the page never fetches the other party's private messages or
  synthesis. The `myMessages` and `mySynthesis` queries enforce party
  scoping server-side; the page must not paper over that boundary.

## Edge cases

- A case with status CLOSED_RESOLVED but no closureSummary (legacy data) —
  show "Resolved" header but no summary card.
- ...

## Non-goals

- Editing or replying to messages in the closed view.
- Showing the other party's private content under any circumstance.
```

The exact frontmatter schema can evolve. Start with the minimum that solves
the WOR-54 / WOR-55 class of failure: `files`, `signatures`, `queries_used`,
`read_only` (where applicable). Add fields as we hit cases that need them.

### No more stub files

With the contract in place, test-gen no longer writes `__stubs__/<symbol>.ts`
files. The contract names the file path and signature the dev agent WILL
create (e.g. `src/hooks/useActingPartyUserId.ts` exporting
`useActingPartyUserId(caseId): string | null`). Test-gen imports directly
from that path. Until dev ships, the test runner returns a clean
"module not found" error — that is the correct red state and is more
informative than a stub file silently passing on a placeholder return value.

The test-gen prompt is updated to forbid creating stub files; the test
reviewer is updated to flag any new stub file as a contract-coordination
smell and reject it. The two existing `tests/wor-55/__stubs__/` files can
stay until WOR-55 is done; new tickets do not produce them.

### Test reviewer expectations during the red state

When the test reviewer evaluates tests for a new ticket, the implementation
does not yet exist. So:

- "Module not found" or "ImportError" failures on a freshly-written test
  file targeting a contract-specified path are **expected** and should be
  reported in the verdict as `state: pre_implementation_red`, not as a
  test bug.
- The reviewer's job in that state is to confirm the tests would pass
  *if* the dev agent built exactly what the contract specifies. The
  reviewer reads the contract + tests + AC together and verifies the
  three are mutually consistent.
- A stub file or a mock that papers over a missing import is a smell
  the reviewer should reject — the failure mode it covers (silent
  passing against placeholder values) is exactly what we are trying
  to eliminate.

### Test-gen and dev-attempt prompt updates

Both commands receive a new input — the absolute path to the contract file —
and are told to treat the contract as canonical for any interface decision.

```
You will be given:
- The user story and acceptance criteria (in trigger-payload.json /
  task-context.md)
- The contract at $CONTRACT_PATH

Treat the contract as canonical. If a signature, file path, or invariant
appears in the contract, do not deviate. If you believe the contract is
wrong, write the work the way the contract says and surface your concern in
your final report (which the reviewer will see). Do not silently diverge.
```

The same change goes into both:
- `archon-test-gen.md` (test author)
- `archon-dev-attempt.md` (implementation author, used by dev-attempt-1, -2,
  and -loop)
- `archon-implement-fixes.md` (the existing fix-implementer command — same
  treatment)

### Reviewer also reads the contract

The test reviewer (the existing pre-implementation review step) gets the
contract path as well. Its job expands slightly — it now reviews two things
at once:

- **Do the tests make sense given the contract?** Do they exercise the
  contracted signatures, queries, and invariants? Are they overfit to
  implementation details not in the contract? Do they leave AC uncovered?
- **Does the contract itself make sense?** Is it complete enough to write
  tests against? Are there obvious gaps, ambiguous signatures, or invariants
  that should have been called out but were not?

If the reviewer finds the contract itself is broken, the verdict comes back
as `contract_inadequate` and the workflow loops back to `contract-create` to
regenerate. We expect this to be rare. If it happens often we will add a
dedicated contract-review node, but for now it is folded into the existing
test review step.

The dev-loop reviewer (the existing per-attempt review) also reads the
contract — its diagnoses are dramatically more accurate when it can see the
canonical interface, as WOR-54's attempt-3 review demonstrated (the first
two reviews misdiagnosed the failure; the third one found the root cause).

### Coverage interpretation note

Most unit tests in this project mock `convex/react`'s `useQuery`/`useMutation`
and the generated api module. Line-coverage % from those tests reflects
React rendering paths, not data-fetching or privacy-enforcement contracts.
Two consequences:

- A component reporting 95% line coverage from unit tests can have 0%
  coverage of its query contracts. WOR-54's recovered failure was exactly
  in that gap.
- The `tested_by` field above is the canonical signal for "is this AC
  actually verified, and at which layer?" — coverage % alone is not.

When PR 5 (metrics) lands, the metrics report should split coverage by
test layer (unit / e2e) per source file. Until then, the test reviewer
is responsible for cross-checking the `tested_by` field against the
written tests.

### Files touched

- `.archon/workflows/task-tests.yaml` — add `contract-create` node before
  `test-gen`. Wire the contract path through to `test-gen`.
- `.archon/workflows/task-implement.yaml` — wire the contract path through
  to every dev-attempt and to `implement-fixes`. The dev-loop reviewer also
  receives it.
- `.archon/commands/archon-contract-author.md` — new. Owns the
  contract-creation prompt with the phases above.
- `.archon/commands/archon-test-gen.md` — updated with the "read the
  contract" preamble.
- `.archon/commands/archon-dev-attempt.md` — same update.
- `.archon/commands/archon-implement-fixes.md` — same update (already exists
  as our own command, not bundled).
- `.archon/commands/archon-test-review.md` — updated to also review the
  contract; new verdict category `contract_inadequate`.
- `.archon/commands/archon-dev-review.md` (the per-attempt reviewer) —
  updated to receive the contract.
- The cage hook gets one more deny rule: writes to `.archon/contracts/`
  after the contract has been committed, blocked the same way `tests/` and
  `e2e/` are protected from the dev agent.
- `ARCHIE_PIPELINE.md` — update the workflow diagram + description.

### Acceptance

- A new ticket flows through the contract path end-to-end: contract is
  written, test-gen and dev-attempt both read it, the merged PR shows the
  signatures in code match the signatures in the contract.
- The WOR-54-style failure is reproduced as a synthetic regression test:
  test-gen and dev-gen are given conflicting interpretations of the same
  AC; without the contract, they diverge; with the contract in place, they
  converge.
- Existing in-flight tickets that started before the cutover continue to
  finish on the old path (i.e. PR 1 does not break anything mid-flight).

### Out of scope

- Dedicated contract-review workflow. Folded into the existing test review.
- Contract-objection artifact. If an agent thinks the contract is wrong, it
  raises the concern in its final report and the reviewer decides.
- Hash-based immutability enforcement. The cage hook + read-only convention
  is enough; if we see contracts being mutated despite that, revisit.
- Auto-amendment of contracts. If the test reviewer says
  `contract_inadequate`, the workflow loops back to `contract-create` and
  the agent regenerates from scratch with the previous attempt's feedback.

---

## PR 2 — Inline prompts → commands

**Why second:** PR 1 already promotes several prompts to commands (the
contract author, the test reviewer, the dev reviewer). The remaining inline
prompts in the workflows should follow the same pattern so we have a single
authorship surface across the pipeline.

**Approach:**

1. Inventory every remaining inline `prompt:` node across `epic-decompose`,
   `task-tests`, `task-implement`, `task-done`, `jira-router`. Expect 10–15
   after PR 1 lands.
2. For each, extract to `.archon/commands/<role-name>.md`. Project-level by
   default; promote to `~/.archon/commands/` only if clearly cross-project.
3. Replace the inline `prompt:` with `command: <name>`.
4. Where multiple commands need the same preamble (cage rules on
   dev-attempt-1, -2, implement-fixes), duplicate the preamble text into
   each command file. No composition mechanism.

**Acceptance:**

- Diff review confirms every extracted prompt is byte-identical to its
  inline source.
- One full pipeline run on a ConflictCoach ticket succeeds end-to-end on
  the new wiring.

---

## PR 3 — Verdict schema (prompt-level only)

**Why third, and why small:** the original design doc proposed a Zod schema
+ runtime validation + leakage_check enforcement. In practice, the verdict
is consumed by the next agent's prompt, not by code. Standardizing the
**output format** in the reviewer's prompt is enough to get most of the
benefit. Schema-level validation is a follow-up if structured output drifts.

**What changes:**

- Update `archon-dev-review.md` and `archon-test-review.md` (and the
  synthesizer command, when the synthesizer fix from `ARCHIE_PIPELINE.md` open
  items lands) to require their final output in a fixed shape:
  ```yaml
  status: pass | fail
  category: contract_mismatch | ac_mismatch | api_mismatch | ...
  summary: <one-paragraph diagnosis>
  impact: <what is broken from the user's perspective>
  recommendation: <what the next attempt should do>
  ```
- The downstream consumer (`task-parse-synthesis.ts`, the next dev-attempt
  prompt) extracts these fields by regex/grep — same approach we already
  use for the synthesis verdict. No new schema runtime.
- Add `verify-reviewer-artifacts` guard node before `synthesize` (the
  deferred fix from `ARCHIE_PIPELINE.md` open items): fail the workflow if
  zero `*-findings.md` files exist on disk before synthesize runs.

**Acceptance:**

- Verdicts have a consistent shape across the three reviewer types.
- The synthesizer hallucination scenario from `ARCHIE_PIPELINE.md` (all
  reviewers cascade-skip → synthesize fabricates) is caught by the new
  guard node and the workflow halts loudly instead.

**Out of scope:**

- Zod schema with runtime validation in the engine. Add only if drift shows
  up.
- `leakage_check` field. The reviewers don't currently leak test contents
  in practice; add only if we see it happening.

---

## PR 4 — Conflict domains (deferred, optional)

**Why deferred:** PR 1 already eliminates the test/code coordination
failures that drive most of the bad outcomes. The sibling-deletion failures
(WOR-77 et al.) were also coordination failures, but the cage hook plus
disciplined contracts that explicitly list `files:` ought to prevent them
indirectly: if the contract says "this ticket touches `src/components/X.tsx`
and nothing else," and the dev attempt is told to honor the contract, the
existing cage hook can pick up the file list from the contract and enforce
it.

**Defer until:** we observe a sibling-deletion failure on a ticket that did
have a contract. If that happens, then PR 4 lands with the explicit
`conflict_domains: [...]` mechanism. Until then, the contract's `files:`
list is the safety mechanism.

---

## PR 5 — Retry classification + metrics (deferred, optional)

**Why deferred:** valuable for long-term improvement but not blocking
anything. After PR 1 lands, retry counts should drop substantially; once we
have a few weeks of post-PR-1 data, classifying the remaining retries will
be more useful than trying to classify the current noisy data.

**When to revisit:** after PR 1 has been in production for at least one
ConflictCoach Epic-worth of tickets and we want to know what is *still*
causing retries.

---

## PR 6 — Bug ticket workflow

**Independent of PRs 1–5.** A new piece of functionality needed once the
initial Epic's tickets are done and ConflictCoach starts taking real bug
reports.

**Scope:**

- Router rule in `jira-router.yaml`: issue type `Bug` (or label `bug`)
  routes to `bug-triage` instead of the standard contract path.
- New workflow `bug-triage.yaml`: reads the bug report, fetches related
  code context, produces:
  - A reproduction artifact (`.archon/contracts/<issue-key>.repro.md`).
  - A bug contract — same shape as a normal contract (so PR 1's machinery
    is reused) plus extra fields: `regression_test_required: true`,
    `repro_artifact: <path>`.
- New commands: `archon-bug-reproducer.md`, `archon-bug-contract-author.md`.
- Otherwise reuses the standard `task-tests` and `task-implement` pipeline
  unchanged — once a bug contract exists, the rest of the pipeline does not
  care whether the work is feature or bug.
- `task-done.ts` updated so bug closures post the reproduction text and
  link to the regression-test path in the Jira closing comment.

**Acceptance:**

- Synthetic bug filed against ConflictCoach with a known repro flows
  end-to-end: triage produces repro + contract → test-gen writes the
  regression test (failing) → dev-attempt fixes the code → tests pass →
  PR merges → Jira closes with the repro in the comment.

---

## PR 7 — Feature request workflow

**Independent of PRs 1–6.** Same shape as PR 6 — new functionality, not a
modification of existing flow.

**Scope:**

- Router rule in `jira-router.yaml`: issue type `Story` with label
  `feature-request` routes to `feature-request-triage`.
- New workflow `feature-request-triage.yaml`: produces a PRD-fragment
  artifact and decomposes the request into 1–N child tickets via the same
  `epic-decompose` machinery (smaller fanouts; bias to 1–5 children).
- New commands: `archon-feature-request-prd-author.md`,
  `archon-feature-request-decomposer.md`.
- Each child ticket then enters the standard contract → test → implement →
  review path from PR 1.
- Parent feature-request ticket auto-rolls up to Done when all children
  are Done — reuses the epic-rollup logic in `jira-task-done.ts`.

**Acceptance:**

- Feature request filed against ConflictCoach generates child tickets,
  each child flows through the standard pipeline, parent auto-Dones after
  the last child merges.

---

## Sequencing summary

| PR | Title | Depends on | Status |
|----|-------|------------|--------|
| 1 | Contract artifact | — | the main lever; required |
| 2 | Inline prompts → commands | — | recommended; cleanup |
| 3 | Verdict schema (prompt-level) | — | small; nice to have |
| 4 | Conflict domains | observation that PR 1's `files:` isn't enough | deferred |
| 5 | Retry classification + metrics | a few weeks of post-PR-1 data | deferred |
| 6 | Bug ticket workflow | needs PR 1 (reuses contract machinery) | new functionality |
| 7 | Feature request workflow | needs PR 1 (reuses contract machinery) | new functionality |

PR 1 is the cutover. PRs 2 and 3 can be merged in any order, before or
after PR 1. PRs 4 and 5 are conditional — only worth doing if we observe
the failure modes they address. PRs 6 and 7 are independent new features,
required only when we move past the initial Epic into bug-fix and
feature-request operating mode.

---

## When to start

**Now**, for PR 1.

ConflictCoach has 3 tickets in `Selected for Development` (WOR-46, WOR-36)
plus the parent epic, and no test-gen workflows are running for them
because earlier `task-tests` runs failed silently at `verify-tests-exist`.
Holding PR 1 until "the Epic finishes" is therefore not a meaningful
constraint — the Epic is already paused on those tickets, and unblocking
them benefits more from the contract-driven flow than from re-running the
old flow.

Cutover plan:

1. Land PR 1 against `feature/jira-adapter` (the Archon branch), not
   ConflictCoach. The change is to Archon's workflow YAML + commands.
2. Verify on a synthetic test ticket (one we file ourselves into Jira)
   that the contract-create node fires before test-gen, the contract
   artifact lands at `.archon/contracts/<key>.md`, and test-gen + dev
   both read it.
3. Re-trigger WOR-46 and WOR-36 through the new pipeline (transition
   them Backlog → Selected-for-Dev). Watch them flow through the
   contract-driven flow.
4. If those land cleanly, the rest of the Epic's tickets continue on
   the new flow as they decompose.

PRs 2 and 3 can land alongside or after PR 1 — they don't change ticket
lifecycle. PRs 4 and 5 stay deferred until we have post-PR-1 data
suggesting they're needed. PRs 6 and 7 are scheduled for whenever
ConflictCoach is ready to handle bug reports and feature requests.
