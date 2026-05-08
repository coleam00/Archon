# Adversarial Plan Creation (mark4)

Each iteration is a fresh agent. You play ONE role this iteration,
determined by the `phase` field in `$ARTIFACTS_DIR/plan-state.json`.
The two roles are GENERATOR and EVALUATOR. They alternate by round.

---

## Phase 1 — LOAD

Read these inputs:
- `$ARTIFACTS_DIR/plan-state.json` — has `phase`, `round`, `maxRounds`,
  `passThreshold`, `status`. Determines which role you play.
- `$ARTIFACTS_DIR/epic.md` — the PRD / epic source.
- `$ARTIFACTS_DIR/attachments.md` — technical specs, design docs, style
  guides, stack notes, testing notes, deployment notes, or other attachments.
- If `round > 1`, also read:
  - `$ARTIFACTS_DIR/plan-evaluations/round-<round-1>.json`
  - `$ARTIFACTS_DIR/plan-current.json`

**Phase 1 checkpoint:**
- [ ] You read `plan-state.json` and identified your role from `phase`.
- [ ] You read `epic.md` and `attachments.md`.
- [ ] If round > 1, you read the prior evaluation and prior plan.

Now jump to whichever role section your phase says.

---

## ROLE: GENERATOR (phase = "generating")

### Phase 2 — PROCESS (generator)

**Central question:** *Decompose the project into implementation tasks that are
specific enough to build and test correctly, while preserving any real setup
gates, external service requirements, stack-specific testing requirements, and
design/product constraints found in the inputs.*

#### 2.1 Extract Load-Bearing Project Facts

Before writing phases or tasks, identify the following from the input docs:

1. **Primary application runtime(s)**
   - Example categories: web framework, backend runtime, mobile runtime,
     serverless runtime, database runtime, realtime runtime, job/scheduler
     runtime.
   - These are app-owned execution environments and should generally be
     tested with their real test harness/emulator/runtime, not mocked.

2. **External services and human-provided inputs**
   - Example categories: managed database project, auth provider, email/SMS
     provider, AI provider, payment provider, deployment platform, storage
     provider, analytics provider, maps/geocoding provider, third-party API.
   - Identify which require credentials, API keys, project creation,
     callback URLs, DNS/domain setup, hosted deployments, or admin console
     configuration.

3. **Official or stack-appropriate testing harnesses**
   - If the docs, stack rules, or ecosystem imply an official test harness,
     emulator, local runtime, test container, framework test client, or
     provider-supported test mode, require that for behavior tests.
   - Do not mock the primary app runtime, database, auth/session boundary,
     framework lifecycle, generated SDK/client, router, or server functions
     when a realistic harness is available.
   - Mocks are appropriate for true external side-effect services unless the
     docs require live verification.

4. **User-visible flows and critical invariants**
   - Map all user stories, major workflows, permission boundaries, privacy or
     security guarantees, lifecycle/state-machine rules, and product launch
     criteria.

5. **Design and interaction requirements**
   - Extract visual language, layout constraints, accessibility requirements,
     component behavior, loading/error/empty states, responsive behavior,
     and any “must feel like” product constraints.

Record important decisions in `planning_assumptions`, but do not invent
product behavior unless needed to resolve a contradiction or gap. When you
do infer, label it clearly as an assumption.

#### 2.2 Decide the Plan Structure

Use **a strict setup phase only when the project has real setup gates**.

A setup gate exists when meaningful implementation or verification depends on
human-provided credentials, hosted projects, provider configuration, callback
URLs, deployment accounts, local emulators, or environment variables.

If a setup gate exists, create an initial phase such as:

- `P0 — Setup / Environment / Human Inputs`

This phase should include tasks that verify the required services are actually
usable, not merely documented.

Examples of setup-gate acceptance criteria, written generically:
- Required env vars are documented in an example env file.
- Required provider project/account exists or a mock/test-mode substitute is
  explicitly approved.
- Local dev command connects to the intended runtime or emulator.
- Schema/migrations/config can be applied successfully.
- A smoke query/request/job/auth check/deploy check proves the integration.
- Test harness for the primary app runtime is installed and proven with one
  real behavior test.

After setup, use **milestones for readability**, but decompose work by
capability, user story, system surface, and dependency graph. Do not force
tasks into rigid phases if that hides real dependencies.

#### 2.3 Decompose Into Tasks

Within each phase or milestone, cut work into the smallest cohesive units.

A cohesive unit usually centers on one primary surface:
- schema / migration
- backend query/mutation/endpoint/action/job
- frontend component/view
- shared helper/module
- integration adapter
- test harness / fixture infrastructure
- deployment/config surface
- accessibility/error-state pass for a bounded area

Many ACs on one cohesive surface is good. A task that mixes unrelated backend,
frontend, testing, deployment, and design work is too large unless the surface
is truly inseparable.

#### 2.4 Testing Policy

**Hard rule: do NOT author standalone feature test tasks.**

Tests are part of the feature task that introduces or changes behavior.
The only standalone test-related tasks allowed are:
- initial test runner setup
- stack-specific test harness/emulator setup
- shared fixtures/test utilities
- CI orchestration
- suite hardening / flake reduction

Every task that changes behavior must include acceptance criteria specifying
the relevant test coverage.

For user-visible behavior, include browser/UI/e2e coverage when the behavior
can only be meaningfully verified through the product interface.

For backend or runtime behavior, use the stack-appropriate real harness,
emulator, test runtime, or framework test client when available. Do not mock
the primary application runtime merely for convenience.

For pure helper modules, ordinary unit tests are appropriate.

For true external services, use provider test mode, mocks, fakes, or live
verification according to the input docs and the task’s purpose.

Each feature task’s acceptance criteria should make clear:
- what behavior is tested
- what layer tests it: unit, integration, component, browser/e2e, smoke
- what must not be mocked
- what may be mocked
- what setup or fixture is required

#### 2.5 Wire Dependencies Explicitly

Declare `depends_on` using task IDs across the entire plan, not only within a
phase.

Do not rely on “phase N must finish before phase N+1” to hide dependencies.
If task T17 needs a helper, schema, design token, auth helper, fixture,
emulator, provider setup, prompt/template, state machine, or shared component
from T4, list `T4` in `depends_on`.

Dependencies should be real technical or product dependencies, not merely
chronological preference.

#### 2.6 Author Per-Task Fields

Each task has:
- `task_id` — stable label T1..TN in plan order
- `title` — short, specific, names the primary code/config/test surface
- `summary` — 2-4 sentence prose
- `acceptance_criteria` — array of concrete, testable assertions. Be
  exhaustive. Include required test coverage as ACs on the feature task.
- `depends_on` — array of task_ids across the whole plan
- `suggested_jira_type` — `Task` or `Story`
- `original_estimate_minutes` — autonomous-agent end-to-end estimate
- `source_refs` — array of source references from the input docs, such as
  `PRD US-03`, `TechSpec §4.2`, `DesignDoc §3.1`. Use best available labels.
- `human_inputs_required` — array of human-provided credentials/config/decisions
  required for this task, or `[]`
- `verification_mode` — one of:
  - `mock_only`
  - `local_harness`
  - `provider_test_mode`
  - `live_smoke`
  - `not_applicable`

Use `human_inputs_required` and `verification_mode` to make setup gates and
test realism visible.

#### 2.7 If Round > 1, Address Every Prior Objection

Read `plan-evaluations/round-<round-1>.json`. For each objection, identify the
change you are making. Apply the changes. The evaluator will check.

**Phase 2 checkpoint (generator):**
- [ ] Every PRD user story maps to at least one task.
- [ ] Every implementation-relevant NFR maps to task ACs.
- [ ] Load-bearing external services and human inputs are identified.
- [ ] Any real setup gate has a setup phase with verification ACs.
- [ ] Stack-specific testing harness/emulator requirements are captured.
- [ ] No standalone feature test tasks exist.
- [ ] Feature tasks include their own test coverage ACs.
- [ ] Dependencies are explicit across the whole plan.
- [ ] Design/product requirements are represented in relevant UI tasks.
- [ ] Each task is one cohesive surface or clearly justified.
- [ ] If round > 1, every prior objection has a specific change.

### Phase 3 — GENERATE (generator)

Author `$ARTIFACTS_DIR/plan-current.json` in this exact shape:

```json
{
  "epic_title": "string",
  "planning_assumptions": ["string"],
  "phases": [
    {
      "phase_id": "P0",
      "goal": "one-sentence statement",
      "completion_condition": "what's true at end of phase",
      "tasks": [
        {
          "task_id": "T1",
          "title": "...",
          "summary": "...",
          "acceptance_criteria": ["...", "..."],
          "depends_on": [],
          "suggested_jira_type": "Task",
          "original_estimate_minutes": 30,
          "source_refs": ["..."],
          "human_inputs_required": [],
          "verification_mode": "local_harness"
        }
      ]
    }
  ]
}
```

Tasks within a phase are listed in plan order. Task IDs are unique across the
whole plan.

### Phase 4 — COMMIT (generator)

Write the JSON to `$ARTIFACTS_DIR/plan-current.json` using pretty JSON,
2-space indent.

Verify on disk:
- File size > 0 bytes
- Parses as valid JSON
- Top-level has `epic_title`, `planning_assumptions`, `phases`
- Every phase has `tasks` as a non-empty array
- Every task has all required fields:
  - `task_id`
  - `title`
  - `summary`
  - `acceptance_criteria`
  - `depends_on`
  - `suggested_jira_type`
  - `original_estimate_minutes`
  - `source_refs`
  - `human_inputs_required`
  - `verification_mode`

Update `$ARTIFACTS_DIR/plan-state.json`: set `"phase": "evaluating"`.
Other fields unchanged.

**Phase 4 checkpoint (generator):**
- [ ] `plan-current.json` is valid JSON with all required fields.
- [ ] `plan-state.json` has `phase: evaluating`.

### Phase 5 — REPORT (generator)

Output one line summary:

`Generated plan v<round> with <N> phases and <M> tasks.`

Do NOT emit `<promise>PLAN_CONVERGED</promise>`.

---

## ROLE: EVALUATOR (phase = "evaluating")

### Phase 2 — PROCESS (evaluator)

**Central question:** *What flaws in this plan would cause downstream tickets,
tests, or implementation to be wrong, fake-green, under-specified, misordered,
or unfaithful to the input docs? Be specific. Be adversarial.*

Read `$ARTIFACTS_DIR/plan-current.json`.

Score the plan on these dimensions.

#### Per-Phase Scoring

Each phase is scored 1-10 on:

- **coverage** — does this phase deliver every commitment its goal promises?
  Any user story, NFR, setup requirement, design requirement, or technical
  surface missing from this phase?
- **sizing** — any tasks too large, too small, or mixed-domain?
- **dependencies** — are dependencies explicit and correct? Any hidden deps,
  cycles, missing cross-phase deps, or phantom deps?
- **testability** — are ACs concrete enough to test? Does each behavior task
  include its own test coverage expectations?
- **setup_realism** — if this phase depends on external services, credentials,
  hosted projects, local emulators, or provider configuration, are those inputs
  explicit and verified before dependent work?
- **testing_realism** — does the plan use realistic stack-appropriate harnesses
  for app-owned runtimes instead of mocking the thing under test?
- **source_fidelity** — does the phase preserve the PRD/spec/design intent
  without inventing unmarked product behavior?

#### Cross-Plan Scoring

Score 1-10 on:

- **ordering** — are phases/milestones ordered correctly?
- **boundary_clarity** — does each phase have a clear stakeholder-verifiable
  completion condition?
- **transition_gates** — does later work have everything it needs from earlier
  work, including human inputs and verified setup?
- **dependency_explicitness** — are dependencies explicit across the whole
  plan rather than hidden behind phase boundaries?
- **feature_owned_testing** — are tests attached to feature tasks, with only
  infrastructure/CI/suite-hardening as standalone test tasks?
- **privacy_security_fidelity** — if the input docs include privacy, security,
  permissions, tenancy, data isolation, compliance, auditability, or safety
  constraints, are they enforced across data, runtime, UI, and tests?
- **design_fidelity** — if the input docs include design/UX requirements, are
  they represented in relevant UI/component tasks and acceptance criteria?

#### Hard Checks

Flag an objection if any of these occur:

- A feature behavior is only tested by a later standalone test task.
- The plan mocks the primary application runtime/database/auth/router/server
  lifecycle/generated SDK when the docs or ecosystem imply a realistic harness.
- A real external credential/setup requirement is not represented in
  `human_inputs_required` or setup tasks.
- A task depends on another task but omits it from `depends_on`.
- A product behavior is invented without being marked as an assumption.
- A user story or launch criterion has no traceable task.
- A design requirement has no task or AC where it should affect UI.
- A security/privacy/permission requirement lacks enforcement and test ACs.
- Setup phase exists but does not prove the setup with a smoke test or
  harness verification.

Score honestly. Do not grade on a curve. 8 means genuinely acceptable.
Below 8 is a real problem.

### Phase 3 — GENERATE (evaluator)

Write `$ARTIFACTS_DIR/plan-evaluations/round-<round>.json`:

```json
{
  "round": 1,
  "phase_scores": [
    {
      "phase_id": "P0",
      "scores": {
        "coverage": 8,
        "sizing": 9,
        "dependencies": 8,
        "testability": 8,
        "setup_realism": 9,
        "testing_realism": 8,
        "source_fidelity": 8
      }
    }
  ],
  "cross_phase_scores": {
    "ordering": 9,
    "boundary_clarity": 8,
    "transition_gates": 8,
    "dependency_explicitness": 8,
    "feature_owned_testing": 8,
    "privacy_security_fidelity": 8,
    "design_fidelity": 8
  },
  "passed": false,
  "objections": [
    {
      "scope": "phase|cross_phase",
      "phase_id": "P0",
      "dimension": "setup_realism",
      "task_ids": ["T1"],
      "issue": "Specific finding with copy-pasteable detail.",
      "fix": "What the generator should change."
    }
  ],
  "summary": "One paragraph: what's good, what must change."
}
```

`passed` is `true` ONLY if:
- every per-phase score >= passThreshold
- every cross-plan score >= passThreshold
- `objections` is empty

### Phase 4 — COMMIT (evaluator)

Write the evaluation JSON.

Verify on disk:
- Parses as valid JSON
- Has all required fields

Update `$ARTIFACTS_DIR/plan-state.json`:
- If `passed`: set `phase: "converged"`, `status: "converged"`.
  Copy `plan-current.json` to `plan-final.json`.
- If failed and round < maxRounds: set `phase: "generating"`,
  increment `round`.
- If failed and round >= maxRounds: set `phase: "maxed-out"`,
  `status: "maxed-out"`. Copy `plan-current.json` to `plan-final.json`.

**Phase 4 checkpoint (evaluator):**
- [ ] Evaluation JSON written and valid.
- [ ] `plan-state.json` updated to next phase or terminal status.
- [ ] If converged or maxed-out, `plan-final.json` exists.

### Phase 5 — REPORT (evaluator)

If `status` is `converged` or `maxed-out`, output
`<promise>PLAN_CONVERGED</promise>` as the very last line.

Otherwise output:

`Round <N> evaluation: passed=<bool>, <K> objections.`

Do NOT emit the completion signal unless terminal.
