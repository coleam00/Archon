---
name: "speckit-clarifybatch"
description: "Batch-mode clarification — generate all questions to a file, let the user fill answers offline, then apply the entire batch to the spec in one pass. Supports --apply (force apply) and --turn[=N] (override the question quota for the DRAFT phase; optional integer N, 1–20; defaults to 5)."
compatibility: "Requires spec-kit project structure with .specify/ directory"
metadata:
  author: "github-spec-kit"
  source: "templates/commands/clarifybatch.md"
---


## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty). The input may contain mode flags (`--apply`, `--turn`, `--turn=N`, `--turn N`) AND/OR free-form prioritization context.

## Pre-Execution Checks

**Check for extension hooks (before clarification)**:
- Check if `.specify/extensions.yml` exists in the project root.
- If it exists, read it and look for entries under the `hooks.before_clarify` key
- If the YAML cannot be parsed or is invalid, skip hook checking silently and continue normally
- Filter out hooks where `enabled` is explicitly `false`. Treat hooks without an `enabled` field as enabled by default.
- For each remaining hook, do **not** attempt to interpret or evaluate hook `condition` expressions:
  - If the hook has no `condition` field, or it is null/empty, treat the hook as executable
  - If the hook defines a non-empty `condition`, skip the hook and leave condition evaluation to the HookExecutor implementation
- For each executable hook, output the following based on its `optional` flag:
  - **Optional hook** (`optional: true`):
    ```
    ## Extension Hooks

    **Optional Pre-Hook**: {extension}
    Command: `/{command}`
    Description: {description}

    Prompt: {prompt}
    To execute: `/{command}`
    ```
  - **Mandatory hook** (`optional: false`):
    ```
    ## Extension Hooks

    **Automatic Pre-Hook**: {extension}
    Executing: `/{command}`
    EXECUTE_COMMAND: {command}

    Wait for the result of the hook command before proceeding to the Outline.
    ```
- If no hooks are registered or `.specify/extensions.yml` does not exist, skip silently

> Hook namespace note: this command intentionally reuses `before_clarify` / `after_clarify` (NOT `before_clarifybatch`). Reason: existing extensions register against the established `clarify` namespace; reusing it keeps gating behavior identical between `/clarifybatch` (batch) and `/clarify` (interactive).

## Outline

Goal: Detect and reduce ambiguity or missing decision points in the active feature specification and record the clarifications directly in the spec file — using a **batch-via-file** flow by default so the user is not blocked turn-by-turn.

Note: This clarification workflow is expected to run (and be completed) BEFORE invoking `/speckit-plan`. If the user explicitly states they are skipping clarification (e.g., exploratory spike), you may proceed, but must warn that downstream rework risk increases.

This command supports two runtime modes selected by the flags found in the user input above. `--turn` is a quota knob, never a mode switch:

| Flags in `$ARGUMENTS` | Mode | What happens |
|---|---|---|
| (no flag) | **AUTO** | Auto-detect phase via the questions file in the feature dir. `MAX_QUESTIONS = 5`. |
| `--turn` / `--turn=N` / `--turn N` | **AUTO** | Same as no-flag, but override `MAX_QUESTIONS` (default 5, integer 1–20). |
| `--apply` | **APPLY (forced)** | Skip generation; require an already-filled questions file; merge into spec. |
| `--apply --turn[=N]` | **APPLY (forced)** | `--turn` is silently ignored in APPLY (no generation phase to size). |

Execution steps:

### Step 0 — Argument parsing

Inspect the literal text inside `$ARGUMENTS` (case-sensitive) for the substrings `--apply` and `--turn`. The `--turn` flag may optionally carry an integer value in either form: `--turn=N` or `--turn N` (a whitespace-separated integer immediately following the flag).

Initialize `MAX_QUESTIONS = 5` (the default question quota — used by every mode). It is overridden only when the user passes a value via `--turn=N` / `--turn N`.

Apply these rules in order:

1. **`--turn` parsing** — if `--turn` is present, extract its optional value:
   - `--turn=<digits>` → set `MAX_QUESTIONS = <digits>`
   - `--turn <digits>` (whitespace, then a token that is purely digits) → set `MAX_QUESTIONS = <digits>`
   - `--turn` followed by end-of-input or a non-digit token → keep `MAX_QUESTIONS = 5`
   - Validate the parsed integer: it MUST be between 1 and 20 inclusive. If the user passed `0`, a negative number, a non-integer (e.g. `--turn=abc`, `--turn=3.5`), or a value > 20, abort with: "`--turn` accepts an integer between 1 and 20. Got: `<value>`."
2. **Mode selection** — `--turn` does NOT influence the mode; it only sets `MAX_QUESTIONS`.
   - `--apply` present → MODE = APPLY-forced. (`--turn` is silently ignored — APPLY skips generation, so the quota has nothing to size.) Continue.
   - `--apply` absent → MODE = AUTO. Continue.

Strip the recognized flags AND any consumed integer value from `$ARGUMENTS` and treat any remaining text as free-form prioritization context (passed to the prioritization heuristic in Block 2 below). When you report mode to the user, also report the resolved `MAX_QUESTIONS` value (e.g. "Mode: AUTO, max questions: 7").

### Step 1 — Resolve feature paths

Run `.specify/scripts/bash/check-prerequisites.sh --json --paths-only` from repo root **once** (combined `--json --paths-only` mode / `-Json -PathsOnly`). Parse minimal JSON payload fields:

- `FEATURE_DIR`
- `FEATURE_SPEC`
- (Optionally capture `IMPL_PLAN`, `TASKS` for future chained flows.)
- If JSON parsing fails, abort and instruct user to re-run `/speckit-specify` or verify feature branch environment.
- For single quotes in args like "I'm Groot", use escape syntax: e.g 'I'\''m Groot' (or double-quote if possible: "I'm Groot").

Compute `QUESTIONS_FILE = {FEATURE_DIR}/clarification-questions.md`.

### Step 2 — Phase detection (AUTO and APPLY-forced only)

- **AUTO**:
  - `QUESTIONS_FILE` does **not** exist → PHASE = DRAFT. Go to **Step 3 — DRAFT phase**.
  - `QUESTIONS_FILE` exists and contains a line `Status: PENDING` → PHASE = APPLY. Go to **Step 4 — APPLY phase**.
  - `QUESTIONS_FILE` exists and contains a line `Status: ARCHIVED` → abort with: "An archived clarifications file exists at `{path}`. Delete it (or rename it) before running clarifybatch again."
  - `QUESTIONS_FILE` exists with no recognizable `Status:` line → abort with: "Cannot parse `{path}` (missing or malformed `Status:` line). Delete the file and re-run."
- **APPLY-forced** (`--apply`):
  - `QUESTIONS_FILE` must exist with `Status: PENDING`. Otherwise abort with: "`--apply` requires `{path}` to exist with `Status: PENDING`. Run `/clarifybatch` first to draft questions."

### Step 3 — DRAFT phase

Load the current spec file. Perform a structured ambiguity & coverage scan using this taxonomy. For each category, mark status: Clear / Partial / Missing. Produce an internal coverage map used for prioritization (do not output raw map unless no questions will be asked).

<!-- VERBATIM from .specify/templates/commands/clarify.md (taxonomy block, lines 69-120). Keep in sync. -->

**Functional Scope & Behavior:**

- Core user goals & success criteria
- Explicit out-of-scope declarations
- User roles / personas differentiation

**Domain & Data Model:**

- Entities, attributes, relationships
- Identity & uniqueness rules
- Lifecycle/state transitions
- Data volume / scale assumptions

**Interaction & UX Flow:**

- Critical user journeys / sequences
- Error/empty/loading states
- Accessibility or localization notes

**Non-Functional Quality Attributes:**

- Performance (latency, throughput targets)
- Scalability (horizontal/vertical, limits)
- Reliability & availability (uptime, recovery expectations)
- Observability (logging, metrics, tracing signals)
- Security & privacy (authN/Z, data protection, threat assumptions)
- Compliance / regulatory constraints (if any)

**Integration & External Dependencies:**

- External services/APIs and failure modes
- Data import/export formats
- Protocol/versioning assumptions

**Edge Cases & Failure Handling:**

- Negative scenarios
- Rate limiting / throttling
- Conflict resolution (e.g., concurrent edits)

**Constraints & Tradeoffs:**

- Technical constraints (language, storage, hosting)
- Explicit tradeoffs or rejected alternatives

**Terminology & Consistency:**

- Canonical glossary terms
- Avoided synonyms / deprecated terms

**Completion Signals:**

- Acceptance criteria testability
- Measurable Definition of Done style indicators

**Misc / Placeholders:**

- TODO markers / unresolved decisions
- Ambiguous adjectives ("robust", "intuitive") lacking quantification

For each category with Partial or Missing status, add a candidate question opportunity unless:

- Clarification would not materially change implementation or validation strategy
- Information is better deferred to planning phase (note internally)

<!-- VERBATIM from .specify/templates/commands/clarify.md (prioritization heuristic, lines 125-134). Keep in sync. -->

Generate (internally) a prioritized queue of candidate clarification questions (maximum `MAX_QUESTIONS`). Apply these constraints:

- Maximum of `MAX_QUESTIONS` total questions across the whole session (default 5; user-overridable via `--turn=N` / `--turn N`, range 1–20).
- Each question must be answerable with EITHER:
  - A short multiple‑choice selection (2–5 distinct, mutually exclusive options), OR
  - A one-word / short‑phrase answer (explicitly constrain: "Answer in <=5 words").
- Only include questions whose answers materially impact architecture, data modeling, task decomposition, test design, UX behavior, operational readiness, or compliance validation.
- Ensure category coverage balance: attempt to cover the highest impact unresolved categories first; avoid asking two low-impact questions when a single high-impact area (e.g., security posture) is unresolved.
- Exclude questions already answered, trivial stylistic preferences, or plan-level execution details (unless blocking correctness).
- Favor clarifications that reduce downstream rework risk or prevent misaligned acceptance tests.
- If more than `MAX_QUESTIONS` categories remain unresolved, select the top `MAX_QUESTIONS` by (Impact * Uncertainty) heuristic.

**If the queue is empty** → respond: "No critical ambiguities detected worth formal clarification." and suggest proceeding to `/speckit-plan`. Do NOT create `QUESTIONS_FILE`. Skip directly to the post-execution hook section.

For each queued question, generate the recommended/suggested answer using the rules below.

<!-- VERBATIM from .specify/templates/commands/clarify.md (multiple-choice rules, lines 138-155). Keep in sync. -->

For multiple‑choice questions:

- **Analyze all options** and determine the **most suitable option** based on:
  - Best practices for the project type
  - Common patterns in similar implementations
  - Risk reduction (security, performance, maintainability)
  - Alignment with any explicit project goals or constraints visible in the spec
- Present your **recommended option prominently** at the top with clear reasoning (1-2 sentences explaining why this is the best choice).
- Format as: `**Recommended:** Option [X] - <reasoning>`
- Then render all options as a Markdown table:

  | Option | Description |
  |--------|-------------|
  | A | <Option A description> |
  | B | <Option B description> |
  | C | <Option C description> (add D/E as needed up to 5) |
  | Short | Provide a different short answer (<=5 words) (Include only if free-form alternative is appropriate) |

<!-- VERBATIM from .specify/templates/commands/clarify.md (short-answer rules, lines 156-159). Keep in sync. -->

For short‑answer style (no meaningful discrete options):

- Provide your **suggested answer** based on best practices and context.
- Format as: `**Suggested:** <your proposed answer> - <brief reasoning>`
- Note: in batch mode the answer format constraint is `Short answer (<=5 words)`.

**Now render the entire queue to `QUESTIONS_FILE`** using the following exact template. Render exactly N Q-blocks where N = number of queued questions (≤ `MAX_QUESTIONS`):

```markdown
# Clarifications — <feature title from spec.md, or `FEATURE_DIR` basename if title missing>

**Status:** PENDING
**Generated:** <current ISO-8601 timestamp, e.g. 2026-05-04T14:59:00+07:00>
**Spec:** <relative path from `QUESTIONS_FILE` to `FEATURE_SPEC`, typically `spec.md`>
**Mode:** batch

**Instructions:**
- Edit each `Your Answer:` line below.
- Type an option letter (A/B/C/...), or `recommended` / `yes` / `suggested` to accept the suggestion, or your own short answer (<=5 words).
- Leave the line blank to skip a question.
- Save the file, then re-run `/clarifybatch` (or `/clarifybatch --apply`) to apply all answers in one pass.

---

## Q1. <question text>

**Category:** <one of the 10 taxonomy categories above>
**Why it matters:** <one-line impact statement>
**Recommended:** <Option X | short phrase> - <reasoning, 1-2 sentences>

| Option | Description |
|--------|-------------|
| A | <...> |
| B | <...> |
| Short | <free-form short answer alternative if applicable> |

**Your Answer:** 

---

## Q2. <question text>

(repeat the Q-block structure above)
```

Notes when rendering:

- Always include the `Your Answer:` line with a single trailing space and no value (the user fills it).
- For pure short-answer questions (no MC table), omit the table entirely and replace the `**Recommended:**` line with `**Suggested:** <answer> - <reasoning>`.
- Include the `Short` table row only when a free-form alternative is meaningful for the question.

**After writing `QUESTIONS_FILE`**: report to the user:

- Path to `QUESTIONS_FILE`.
- Number of questions written + categories covered.
- A reminder: "Edit `Your Answer:` lines, save, then re-run `/clarifybatch` (or with `--apply`) to merge into spec.md."
- Suggested next command: `/clarifybatch` (or `/clarifybatch --apply`) once the file is filled.

Do **NOT** modify `spec.md`. Do **NOT** continue to APPLY in the same run. Skip to the post-execution hook section. (Note: in DRAFT phase the `after_clarify` hooks are NOT fired — the spec was not modified. Only `before_clarify` already fired in pre-execution.)

### Step 4 — APPLY phase

Parse `QUESTIONS_FILE`. For each `## Q<N>.` block extract:

- the question text (the `## Q<N>.` line),
- the `Category:` value,
- the options table (if present) with each row's letter and description,
- the `Recommended:` / `Suggested:` value (the answer to use when the user replied `recommended` / `yes` / `suggested`),
- the **value on the `Your Answer:` line** (everything after the colon, trimmed).

<!-- VERBATIM from .specify/templates/commands/clarify.md (acceptance shortcuts, lines 160-162). Keep in sync; adapted for in-file answers (the "user reply" is the trimmed text on the `Your Answer:` line). -->

Resolve each `Your Answer:` value:

- If empty/blank → SKIP this question (track it as "Outstanding").
- If equal to `yes`, `recommended`, or `suggested` (case-insensitive) → use the previously stated `Recommended:` / `Suggested:` answer.
- Otherwise, validate the answer maps to one option letter (A/B/C/D/E) or fits the <=5 word constraint.
- If ambiguous (e.g. multiple letters, free text >5 words) → mark as "Skipped — ambiguous answer" and continue (do NOT prompt the user; this is batch mode).
- Once satisfactory, record it in working memory.

Load `spec.md` once into memory.

<!-- VERBATIM from .specify/templates/commands/clarify.md (per-answer integration mapping, lines 172-188). Keep in sync. The only batch adaptation is the surrounding write cadence (single write at end vs after each answer). The mapping itself is byte-identical. -->

For the first integrated answer in this batch:

- Ensure a `## Clarifications` section exists in the in-memory spec (create it just after the highest-level contextual/overview section per the spec template if missing).
- Under it, create (if not present) a `### Session YYYY-MM-DD` subheading for today.

For each resolved (non-skipped) answer, in order:

- Append a bullet line under the Session subheading: `- Q: <question> → A: <final answer>`.
- Then immediately apply the clarification to the most appropriate section(s) of the in-memory spec:
  - Functional ambiguity → Update or add a bullet in Functional Requirements.
  - User interaction / actor distinction → Update User Stories or Actors subsection (if present) with clarified role, constraint, or scenario.
  - Data shape / entities → Update Data Model (add fields, types, relationships) preserving ordering; note added constraints succinctly.
  - Non-functional constraint → Add/modify measurable criteria in Success Criteria > Measurable Outcomes (convert vague adjective to metric or explicit target).
  - Edge case / negative flow → Add a new bullet under Edge Cases / Error Handling (or create such subsection if template provides placeholder for it).
  - Terminology conflict → Normalize term across spec; retain original only if necessary by adding `(formerly referred to as "X")` once.
- If the clarification invalidates an earlier ambiguous statement, replace that statement instead of duplicating; leave no obsolete contradictory text.
- Preserve formatting: do not reorder unrelated sections; keep heading hierarchy intact.
- Keep each inserted clarification minimal and testable (avoid narrative drift).

**Batch write cadence (differs from `/clarify`'s per-answer write):** apply ALL parsed answers to the in-memory spec first, then perform validation, then write `spec.md` ONCE atomically. Do NOT save the file between answers.

<!-- VERBATIM from .specify/templates/commands/clarify.md (validation rules, lines 190-196). Keep in sync. -->

Validation (performed on the in-memory spec before the final write):

- Clarifications session contains exactly one bullet per accepted answer (no duplicates).
- Total accepted (non-skipped) answers ≤ `MAX_QUESTIONS`.
- Updated sections contain no lingering vague placeholders the new answer was meant to resolve.
- No contradictory earlier statement remains (scan for now-invalid alternative choices removed).
- Markdown structure valid; only allowed new headings: `## Clarifications`, `### Session YYYY-MM-DD`.
- Terminology consistency: same canonical term used across all updated sections.

Write the updated spec back to `FEATURE_SPEC` (single atomic write).

**Archive the questions file**:

- Compute timestamp: `YYYY-MM-DD-HHMMSS` (e.g. `2026-05-04-145900`).
- Rename `QUESTIONS_FILE` → `{FEATURE_DIR}/clarifications-applied-<timestamp>.md`.
- Inside the renamed file, replace the line `Status: PENDING` with `Status: ARCHIVED` (and optionally append `**Applied:** <timestamp>` underneath).

<!-- VERBATIM from .specify/templates/commands/clarify.md (completion report, lines 200-206). Keep in sync; extended with batch-specific counts and archive path. -->

Report completion:

- Number of questions accepted (applied) + number skipped (outstanding/ambiguous) + total in file.
- Path to updated spec.
- Sections touched (list names).
- Path to the archived questions file.
- Coverage summary table listing each taxonomy category with Status: Resolved (was Partial/Missing and addressed), Deferred (exceeds question quota or better suited for planning), Clear (already sufficient), Outstanding (still Partial/Missing but low impact, OR user left answer blank).
- If any Outstanding or Deferred remain, recommend whether to proceed to `/speckit-plan` or run `/clarifybatch` again later post-plan.
- Suggested next command.

> **Note:** For one-question-at-a-time (interactive sequential) clarification, use `/speckit-clarify` instead. `clarifybatch` is batch-only by design.

### Behavior rules (apply across DRAFT and APPLY)

<!-- Adapted from .specify/templates/commands/clarify.md (behavior rules, lines 208-216). -->

- If no meaningful ambiguities found (or all potential questions would be low-impact), respond: "No critical ambiguities detected worth formal clarification." and suggest proceeding.
- If spec file missing, instruct user to run `/speckit-specify` first (do not create a new spec here).
- Never exceed `MAX_QUESTIONS` total questions (defaults to 5; configurable via `--turn=N` / `--turn N`, range 1–20).
- Avoid speculative tech stack questions unless the absence blocks functional clarity.
- Early termination signals ("stop", "done", "proceed") are no-ops — `clarifybatch` has no per-turn loop. For interactive early-stop semantics, use `/speckit-clarify`.
- If no questions asked due to full coverage, output a compact coverage summary (all categories Clear) then suggest advancing.
- If quota reached with unresolved high-impact categories remaining, explicitly flag them under Deferred with rationale.

Context for prioritization (free-form, after stripping `--apply` / `--turn` flags): $ARGUMENTS

## Post-Execution Checks

**Check for extension hooks (after clarification)**:

> Fire these hooks ONLY when the spec was modified in this run — i.e. APPLY phase. In DRAFT phase the spec is unchanged, so SKIP this section.

Check if `.specify/extensions.yml` exists in the project root.
- If it exists, read it and look for entries under the `hooks.after_clarify` key
- If the YAML cannot be parsed or is invalid, skip hook checking silently and continue normally
- Filter out hooks where `enabled` is explicitly `false`. Treat hooks without an `enabled` field as enabled by default.
- For each remaining hook, do **not** attempt to interpret or evaluate hook `condition` expressions:
  - If the hook has no `condition` field, or it is null/empty, treat the hook as executable
  - If the hook defines a non-empty `condition`, skip the hook and leave condition evaluation to the HookExecutor implementation
- For each executable hook, output the following based on its `optional` flag:
  - **Optional hook** (`optional: true`):
    ```
    ## Extension Hooks

    **Optional Hook**: {extension}
    Command: `/{command}`
    Description: {description}

    Prompt: {prompt}
    To execute: `/{command}`
    ```
  - **Mandatory hook** (`optional: false`):
    ```
    ## Extension Hooks

    **Automatic Hook**: {extension}
    Executing: `/{command}`
    EXECUTE_COMMAND: {command}
    ```
- If no hooks are registered or `.specify/extensions.yml` does not exist, skip silently
