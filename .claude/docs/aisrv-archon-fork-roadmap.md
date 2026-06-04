# AISRV Archon fork roadmap

## Goal

Turn Archon from a general-purpose remote workflow tool into a reliable coding/orchestration system for AISRV PRD execution.

This fork should make the system itself own the invariants we currently enforce with wrappers:

- one active PRD run identity at a time
- a durable canonical PRD source branch
- explicit separation between source branch and ephemeral execution worktree
- run-id-based resume instead of heuristic workflow-name/path resume
- immediate provenance verification after launch/resume
- first-class honest blocked/live-blocked outcomes
- safe recovery without silently mutating another process's active run

## Why fork instead of wrappers only

`archon-ops` wrappers can reduce operator mistakes, but they cannot fix the core state model:

- duplicate PRD runs remain possible
- worktree/source drift remains possible
- workflow rows can outlive the real subprocess
- resume remains tied to brittle status/path/worktree assumptions
- live-blocked packaging is policy, not native state

If Archon is going to be our coding system, these invariants need to live in Archon core.

## Observed failure classes to eliminate

1. **PRD identity drift**
   - multiple runs for the same PRD
   - no canonical lock/lease per PRD

2. **Source/worktree confusion**
   - relaunch from `main` instead of repaired PRD source
   - nested/generated Archon branches become accidental source of truth
   - resume depends on path assumptions that can be wrong

3. **Run-state dishonesty**
   - DB row says `running` when no live process exists
   - approval/resume semantics rely on status flipping to `failed`
   - stale rows require external archaeology

4. **Control-plane mismatch**
   - CLI/UI/wrappers can all manipulate the same conceptual run differently
   - monitoring/gates act on advisory status rather than explicit ownership

5. **Completion dishonesty**
   - deterministic work with unresolved live gates can be reported as complete/pass

## Non-goals

- do not build a multi-tenant workflow platform
- do not optimize for arbitrary parallel PRD execution initially
- do not add automatic stale-run cancellation based only on timers or log age
- do not preserve compatibility with every existing Archon behavior if it conflicts with coding-system correctness

## Design principles for the fork

### 1. PRD is a first-class execution identity
A PRD run is not just `workflow_name + cwd + status`.

Introduce a first-class identity such as:

- `execution_kind = prd`
- `execution_key = PRD-0045`
- `source_branch = prd/0045-src`
- `execution_branch = feat/prd-0045`

This identity must be present on workflow rows and used by CLI/server operations.

### 2. Lease/ownership instead of heuristic exclusivity
For PRD execution, Archon should maintain a durable lease record that answers:

- which run owns this PRD right now?
- which process/session owns that run?
- what source branch/worktree/provenance is expected?
- is the run active, paused, blocked, completed, or orphan-suspect?

Important: follow `CLAUDE.md` guidance — ambiguous ownership must not be auto-cancelled across process boundaries.

### 3. Canonical source branch is durable; execution worktree is disposable
A PRD needs two distinct concepts:

- **canonical source branch**: durable, reviewed, human-meaningful
- **execution worktree/branch**: ephemeral working environment for a particular run

Relaunch should come from the canonical source branch, not from whichever Archon-generated worktree happens to exist.

### 4. Resume must be run-id based
Resume should bind to a specific run record and verified provenance:

- same PRD identity
- expected source branch
- expected execution branch/worktree
- expected repo root

If provenance fails, resume must fail closed and offer a safe rehydrate/rerun path.

### 5. Verification is part of execution, not an external operator ritual
Every launch/resume should record and verify:

- repo root
- source branch + commit
- execution branch + commit
- worktree path
- cleanliness/bootstrap state

If those do not match expectations, the run should pause/fail with an explicit diagnosis.

### 6. Honest terminal states must be native
For coding-system use, Archon needs first-class truth-preserving end states, at least conceptually:

- `deterministic_complete`
- `deterministic_complete_live_blocked`
- `blocked_requires_human_input`
- `failed_deterministic`
- `completed`

Even if implementation stores these as structured metadata first, the CLI/server/UI should understand and display them directly.

## Probable code hotspots

Initial source inspection suggests these areas matter first:

- `packages/core/src/operations/workflow-operations.ts`
  - current resume/approve/reject/abandon business logic
- `packages/workflows/src/executor.ts`
  - workflow launch + resumed-run hydration path
- `packages/workflows/src/executor-shared.ts`
  - shared execution helpers
- `packages/isolation/src/store.ts`
  - isolation persistence contract
- `packages/isolation/src/pr-state.ts`
  - PR state lookup used in cleanup/lifecycle logic
- likely DB workflow row schemas and workflow-run schemas under `packages/workflows/src/schemas/`
- CLI/server workflow commands/routes

## Phase plan

### Phase 0 — architecture + data model
- define PRD execution identity
- define lease record schema
- define provenance/verification record
- define honest terminal-state vocabulary
- decide compatibility strategy for non-PRD workflows

### Phase 1 — PRD lease + provenance foundation
- add PRD identity fields to workflow runs/metadata
- add lease store/table
- add launch-time provenance capture
- add verify-before-execute and verify-before-resume
- make CLI/server surfaces print explicit PRD identity

### Phase 2 — replace heuristic resume
- deprecate workflow-name/path resumability for PRD mode
- implement run-id-based verified resume
- fail closed on source/worktree mismatch
- add explicit rerun-from-canonical-source flow

### Phase 3 — honest lifecycle states
- teach approval/gate flows about blocked/live-blocked deterministic completion
- stop overloading `failed` as the only post-pause continuation mechanism where possible
- make operator handoff artifacts first-class outputs

### Phase 4 — control-plane simplification
- make one clear coding-system path the blessed path
- ensure CLI/server/UI all use the same core lease/provenance operations
- reduce duplicate behavior across wrappers and adapters

## Suggested first implementation slice

The first slice should be narrow and high value:

1. add a PRD execution identity object to workflow run metadata/schema
2. add a durable lease record keyed by PRD id
3. require launch with explicit `--prd`, `--source-branch`, and `--execution-branch` in coding-system mode
4. record provenance at launch
5. make resume require `run-id` and provenance verification

That slice alone should eliminate most of the source/worktree chaos we observed.

## Immediate local next steps

1. inspect workflow-run schemas and DB storage for the cleanest place to add PRD identity + lease references
2. inspect CLI workflow run/resume code paths and trace how they reach `executeWorkflow()`
3. design the smallest migration needed for lease storage
4. implement Phase 1 behind a coding-system-specific path rather than refactoring everything at once
