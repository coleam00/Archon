---
name: "speckit-analyzebatch"
description: "Batch-mode cross-artifact analysis — generate all findings to a file, let the user fill resolutions offline, then apply the entire batch to spec.md / plan.md / tasks.md in one pass. Mirror of `/speckit-clarifybatch` for analyze. Supports --apply (force apply), --allow-historical-edits (consent for historical SpecKit working records), and --dry-run (preview the integration plan without writing)."
argument-hint: "[--apply] [--allow-historical-edits] [--dry-run] (optional) plus free-form focus context"
compatibility: "Requires spec-kit project structure with .specify/ directory"
metadata:
  author: "github-spec-kit"
  source: "templates/commands/analyzebatch.md"
user-invocable: true
disable-model-invocation: false
---


## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty). The input may contain mode flags (`--apply`, `--allow-historical-edits`, `--dry-run`) AND/OR free-form focus areas (passed to the DRAFT phase to bias which categories are examined first).

## Pre-Execution Checks

**Check for extension hooks (before analysis)**:
- Check if `.specify/extensions.yml` exists in the project root.
- If it exists, read it and look for entries under the `hooks.before_analyze` key
- If the YAML cannot be parsed or is invalid, skip hook checking silently and continue normally
- Filter out hooks where `enabled` is explicitly `false`. Treat hooks without an `enabled` field as enabled by default.
- For each remaining hook, do **not** attempt to interpret or evaluate hook `condition` expressions:
  - If the hook has no `condition` field, or it is null/empty, treat the hook as executable
  - If the hook defines a non-empty `condition`, skip the hook and leave condition evaluation to the HookExecutor implementation
- When constructing slash commands from hook command names, replace dots (`.`) with hyphens (`-`). For example, `speckit.git.commit` → `/speckit-git-commit`.
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

> Hook namespace note: this command intentionally reuses `before_analyze` / `after_analyze` (NOT `before_analyzebatch`). Reason: existing extensions register against the established `analyze` namespace; reusing it keeps gating behavior identical between `/analyzebatch` (batch) and `/analyze` (read-only stdout).

## Outline

Goal: Detect cross-artifact inconsistencies, duplications, ambiguities, and underspecified items across `spec.md`, `plan.md`, `tasks.md` after task generation, then record resolutions directly into those artifacts — using a **batch-via-file** flow so the user is not blocked turn-by-turn.

Note: This analysis workflow is expected to run AFTER `/speckit-tasks` has produced a complete `tasks.md`, and BEFORE `/speckit-implement`. If the user explicitly states they are skipping analysis, you may proceed, but must warn that downstream rework risk increases.

This command supports two runtime modes selected by the flags found in the user input above:

| Flags in `$ARGUMENTS` | Mode | What happens |
|---|---|---|
| (no flag) | **AUTO** | Auto-detect phase via the findings file in the feature dir. |
| `--apply` | **APPLY (forced)** | Skip generation; require an already-filled findings file; merge resolutions into the relevant artifacts. |
| `--allow-historical-edits` | (modifier on APPLY) | Pre-consent to editing historical SpecKit working records (`spec.md` / `plan.md` / `tasks.md` / etc. inside `specs/<feature-id>/`). Required because those files are the audit trail. |
| `--dry-run` | (modifier on APPLY) | Validate resolutions and print the integration plan, but write nothing. |

`--allow-historical-edits` and `--dry-run` are silently ignored in DRAFT phase (no spec edits in draft).

**Constitution Authority**: The project constitution (`.specify/memory/constitution.md`) is **non-negotiable** within this analysis scope. Constitution conflicts are automatically CRITICAL and require adjustment of the spec, plan, or tasks — not dilution, reinterpretation, or silent ignoring of the principle. If a principle itself needs to change, that must occur in a separate, explicit constitution update outside `/analyzebatch`.

Execution steps:

### Step 0 — Argument parsing

Inspect the literal text inside `$ARGUMENTS` (case-sensitive) for the substrings `--apply`, `--allow-historical-edits`, `--dry-run`.

Apply these rules in order:

1. **Mode selection**:
   - `--apply` present → MODE = APPLY-forced. Continue.
   - `--apply` absent → MODE = AUTO. Continue.
2. **Modifier flags** (only meaningful in APPLY phase):
   - `--allow-historical-edits` present → set `ALLOW_HISTORICAL = true`. Default: `false`.
   - `--dry-run` present → set `DRY_RUN = true`. Default: `false`.

Strip the recognized flags from `$ARGUMENTS` and treat any remaining text as free-form focus context (bias which categories are scanned first in the DRAFT phase). When you report mode to the user, also report the resolved modifier flags.

### Step 1 — Resolve feature paths

Run `.specify/scripts/bash/check-prerequisites.sh --json --require-tasks --include-tasks` from repo root **once** (combined `--json --require-tasks --include-tasks` mode / `-Json -RequireTasks -IncludeTasks`). Parse minimal JSON payload fields:

- `FEATURE_DIR`
- `FEATURE_SPEC` (= `FEATURE_DIR/spec.md`)
- `IMPL_PLAN` (= `FEATURE_DIR/plan.md`)
- `TASKS` (= `FEATURE_DIR/tasks.md`)

If any required artifact is missing, abort and instruct the user to run the missing prerequisite (`/speckit-specify`, `/speckit-plan`, or `/speckit-tasks`).

For single quotes in args like "I'm Groot", use escape syntax: e.g 'I'\''m Groot' (or double-quote if possible: "I'm Groot").

Compute `FINDINGS_FILE = {FEATURE_DIR}/analyze-findings-<YYYY-MM-DD>.md`. If a same-date file already exists in DRAFT mode, append `-NN` (e.g. `-02`) to disambiguate (never silently clobber).

### Step 2 — Phase detection (AUTO and APPLY-forced only)

- **AUTO**:
  - No `analyze-findings-*.md` with `Status: PENDING` exists in `FEATURE_DIR` → PHASE = DRAFT. Go to **Step 3 — DRAFT phase**.
  - Exactly one `analyze-findings-*.md` with `Status: PENDING` exists → PHASE = APPLY. Use that file as `FINDINGS_FILE`. Go to **Step 4 — APPLY phase**.
  - Multiple `analyze-findings-*.md` files with `Status: PENDING` exist → abort with: "Multiple pending findings files in `{FEATURE_DIR}`. Resolve or archive all but one before re-running, or pass `--apply <path>`."
  - File exists with `Status: ARCHIVED` only → PHASE = DRAFT (a previous batch was applied; new draft is welcome).
  - File exists with no recognizable `Status:` line → abort with: "Cannot parse `{path}` (missing or malformed `Status:` line). Delete the file and re-run."
- **APPLY-forced** (`--apply`):
  - At least one `analyze-findings-*.md` with `Status: PENDING` must exist. Otherwise abort with: "`--apply` requires a pending findings file in `{FEATURE_DIR}`. Run `/analyzebatch` (without `--apply`) first to draft findings."

### Step 3 — DRAFT phase

#### 3.1 — Load artifacts (progressive disclosure)

Load only the minimal necessary context from each artifact:

**From spec.md:**
- Overview / Context
- Functional Requirements (FR-### identifiers if present)
- Success Criteria (SC-### identifiers; measurable outcomes — performance, security, availability, user success, business impact)
- User Stories
- Edge Cases (if present)
- `## Clarifications` and `## Open Questions` and `## Accepted Risks` sections (already-resolved items must NOT be re-flagged)

**From plan.md:**
- Architecture / stack choices
- Data Model references
- Phases
- Technical constraints

**From tasks.md:**
- Task IDs (T-### or per-template convention)
- Descriptions
- Phase grouping
- Parallel markers `[P]`
- Referenced file paths

**From constitution** (`.specify/memory/constitution.md`):
- Principle names and MUST / SHOULD normative statements

#### 3.2 — Build semantic models

Create internal representations (do not include raw artifacts in output):

- **Requirements inventory**: For each Functional Requirement (FR-###) and Success Criterion (SC-###), record a stable key. Use the explicit FR-/SC- identifier as the primary key when present, and optionally also derive an imperative-phrase slug for readability. Include only Success Criteria items that require buildable work (e.g., load-testing infrastructure, security audit tooling), and exclude post-launch outcome metrics and business KPIs (e.g., "Reduce support tickets by 50%").
- **User story / action inventory**: Discrete user actions with acceptance criteria.
- **Task coverage mapping**: Map each task to one or more requirements or stories (inference by keyword / explicit reference patterns like IDs or key phrases).
- **Constitution rule set**: Extract principle names and MUST / SHOULD normative statements.

#### 3.3 — Detection passes (token-efficient)

Focus on high-signal findings. Limit to **50 findings total**; aggregate remainder in an overflow summary. For each finding, generate a stable ID prefixed by category initial (e.g. `D1`, `A1`, `U1`, `K1`, `V1`, `I1`).

Run all six passes. Free-form focus context from `$ARGUMENTS` (after flag stripping) biases ordering: categories named in the focus context get priority during the 50-finding cap.

##### A. Duplication (`D`)

- Identify near-duplicate requirements
- Mark lower-quality phrasing for consolidation

##### B. Ambiguity (`A`)

- Flag vague adjectives (fast, scalable, secure, intuitive, robust) lacking measurable criteria
- Flag unresolved placeholders (TODO, TKTK, ???, `<placeholder>`, etc.)

##### C. Underspecification (`U`)

- Requirements with verbs but missing object or measurable outcome
- User stories missing acceptance criteria alignment
- Tasks referencing files or components not defined in spec / plan

##### D. Constitution alignment (`K`)

- Any requirement or plan element conflicting with a MUST principle
- Missing mandated sections or quality gates from constitution

##### E. Coverage gaps (`V`)

- Requirements with zero associated tasks
- Tasks with no mapped requirement / story
- Success Criteria requiring buildable work (performance, security, availability) not reflected in tasks

##### F. Inconsistency (`I`)

- Terminology drift (same concept named differently across files)
- Data entities referenced in plan but absent in spec (or vice versa)
- Task ordering contradictions (e.g., integration tasks before foundational setup tasks without dependency note)
- Conflicting requirements (e.g., one requires Next.js while other specifies Vue)

#### 3.4 — Severity assignment

- **CRITICAL**: Violates constitution MUST, missing core spec artifact, or requirement with zero coverage that blocks baseline functionality
- **HIGH**: Duplicate or conflicting requirement, ambiguous security / performance attribute, untestable acceptance criterion
- **MEDIUM**: Terminology drift, missing non-functional task coverage, underspecified edge case
- **LOW**: Style / wording improvements, minor redundancy not affecting execution order

Sort the global findings list by severity descending (CRITICAL → HIGH → MEDIUM → LOW). Within each severity band, sort by category code (alphabetic — `A`, `D`, `I`, `K`, `U`, `V`) for deterministic ordering.

#### 3.5 — Write the findings file

Render the findings file at `FINDINGS_FILE` using the following exact template. Render exactly one `### <ID>` block under §3 for every row in §2 — the §3 block is the resolution stub the user / downstream agent fills offline.

```markdown
# Analyze Findings — <feature title from spec.md, or `FEATURE_DIR` basename if title missing>

**Status:** PENDING
**Generated:** <current ISO-8601 timestamp, e.g. 2026-05-04T14:59:00+07:00>
**Spec:** <relative path from FINDINGS_FILE to FEATURE_SPEC, typically `spec.md`>
**Plan:** <relative path to plan.md>
**Tasks:** <relative path to tasks.md>
**Mode:** batch

**Instructions:**
- Review §2 Findings table.
- For each finding, edit the matching `### <ID>` block in §3 Resolutions Log.
  Fill `Category:` with one of: `spec-fix`, `new-OQ`, `accepted-risk`, `out-of-scope`, `skipped`.
  Fill `Payload:` per the category contract (see §3 stubs for templates).
- Save the file, then run `/analyzebatch --apply` (add `--allow-historical-edits` if any
  `spec-fix` targets `specs/<feature-id>/spec.md` / `plan.md` / `tasks.md`).
- Pass `--dry-run` to preview the integration plan without writing.

---

## 1. Session Summary

<placeholder for maintainer to fill post-review — what risk classes dominated, what
patterns repeated, what context the resolutions need from the next reviewer>

## 2. Findings

| ID | Category | Severity | Location(s) | Summary | Recommendation | Status |
|----|----------|----------|-------------|---------|----------------|--------|
| D1 | Duplication | HIGH | spec.md:L120-134 | Two similar requirements ... | Merge phrasing; keep clearer version |  |
| ... | ... | ... | ... | ... | ... |  |

(One row per finding. `Status` column blank — `/analyzebatch --apply` fills it with
the resolution category from the §3 block.)

**Coverage Summary:**

| Requirement Key | Has Task? | Task IDs | Notes |
|-----------------|-----------|----------|-------|
| FR-001 | yes | T-003, T-007 | |
| ... | ... | ... | ... |

**Constitution Alignment Issues:** (if any, else "None")

**Unmapped Tasks:** (if any, else "None")

**Metrics:**

- Total Requirements: <N>
- Total Tasks: <N>
- Coverage % (requirements with >=1 task): <pct>
- Ambiguity Count: <N>
- Duplication Count: <N>
- Critical Issues Count: <N>

## 3. Resolutions Log

<one block per finding ID from §2. Maintainer fills `Category:` and `Payload:` offline.>

### D1
  Category: 
  Payload: 

### A1
  Category: 
  Payload: 

(... repeat for every finding ID in §2.)

---

## 5. Session Metadata

```yaml
session:
  generated_at: <ISO timestamp>
  feature_dir: <relative path>
  artifacts_analyzed:
    - spec.md
    - plan.md
    - tasks.md
    - .specify/memory/constitution.md
  findings:
    total: <N>
    by_severity:
      critical: <N>
      high: <N>
      medium: <N>
      low: <N>
    by_category:
      duplication: <N>
      ambiguity: <N>
      underspecification: <N>
      constitution: <N>
      coverage: <N>
      inconsistency: <N>
    overflow_dropped: <N>   # findings beyond the 50-finding cap
apply: {}                   # populated by /analyzebatch --apply at apply time
```
```

**Resolution category contracts** — when filling §3, the maintainer (or downstream automation) MUST follow exactly one of the following stub shapes per finding:

```text
### <ID>
  Category: spec-fix
  Payload:
  Target: <path relative to repo root, typically `<feature_dir>/spec.md` | `plan.md` | `tasks.md`>
  Before: <verbatim substring of Target file — literal text, copied as-is>
  After:  <intended replacement of that exact substring>

### <ID>
  Category: new-OQ
  Payload:
  Target: <path; default `<feature_dir>/spec.md` if omitted>
  OQ Text: <one paragraph open question>
  Owner:   <name or role>
  Blocks:  <what this OQ blocks until answered>

### <ID>
  Category: accepted-risk
  Payload:
  Target: <path; default `<feature_dir>/spec.md` if omitted>
  Rationale: <one paragraph why we accept this>
  Tags:      [regulatory-review]   # optional; auto-added by apply if Rationale matches money/regulatory/compliance/disclosure/KYC/AML/SEC/SFC/FCA/GDPR

### <ID>
  Category: out-of-scope
  Payload:
  Cross-reference: <future spec ID or path>
  Reason:          <why deferred>

### <ID>
  Category: skipped
  Payload:
  Reason: <optional one-liner>
```

**`spec-fix` literal-substring contract (CRITICAL — apply rejects anything else):**

- `Before:` MUST be a **verbatim substring** of the `Target:` file — literal text copied from the file using a Read tool. NOT a paraphrase. NOT a description of the gap. NOT a directive like "FR-X is missing …".
- `After:` MUST be the intended replacement of that exact `Before:` substring (so apply does `target.replace(before, after)` mechanically).
- `Before:` MUST appear **exactly once** in `Target:`. Verify with `grep -c -F "<Before>" <Target>` → must equal `1`. If `0`, you paraphrased — re-read `Target:` and copy literal text. If `>1`, expand `Before:` with surrounding context until unique.
- Apply does NOT call an LLM to interpret directives. Prose like `Before: FR-X is missing the mapping for max_tokens` will fail validation with `Before-snippet not found in <target>`.
- Why this contract: deterministic outputs across reruns and CI. The same findings file replayed through `--apply` on a clean checkout MUST produce byte-identical edits. Paraphrased directives destroy that property.

**WRONG (will fail apply):**

```
Before: FR-021 is missing a result-subtype mapping for max_tokens.
After:  Add a row stating max_tokens maps to error_during_execution.
```

**RIGHT (passes apply):**

```
Before: | error_during_execution | runtime errors | errors[0] populated |
After:  | error_during_execution | runtime errors, max_tokens, model_context_window_exceeded | errors[0] populated |
```

**After writing `FINDINGS_FILE`**: report to the user:

- Path to `FINDINGS_FILE`.
- Number of findings written + counts by severity and category.
- A reminder: "Edit §3 Resolutions Log per finding ID, save, then run `/analyzebatch --apply` (add `--allow-historical-edits` if any spec-fix targets historical SpecKit records)."
- Suggested next command: `/analyzebatch --apply`.

Do **NOT** modify `spec.md`, `plan.md`, or `tasks.md`. Do **NOT** continue to APPLY in the same run. Skip to the post-execution hook section. (Note: in DRAFT phase the `after_analyze` hooks are NOT fired — no artifact was modified. Only `before_analyze` already fired in pre-execution.)

### Step 4 — APPLY phase

#### 4.1 — Load and validate findings file

1. **File exists, readable, has `Status: PENDING`**. If filename contains `-applied-` OR the metadata block contains `Status: ARCHIVED`, abort: `ERROR: findings file already archived: <path>. Nothing to apply.`
2. **§2 Findings table present**. Header row matches `| ID | Category | Severity | Location(s) | Summary | Recommendation | Status |`. Extract every data row keyed by `ID`. If table missing or no data rows, abort: `ERROR: findings file <path> contains no §2 Findings table.`
3. **§3 Resolutions Log present**. For every finding ID in §2, verify a corresponding `### <ID>` block exists in §3. Missing blocks abort: `ERROR: §3 Resolutions Log missing block for finding <ID>.`
4. **§5 Session Metadata YAML present**. If missing, warn but continue (apply will append a metadata stanza on completion).

#### 4.2 — Parse resolutions

For each finding ID, extract from its §3 block:

- **`Category:`** — one of `spec-fix` / `new-OQ` / `accepted-risk` / `out-of-scope` / `skipped`. If missing or blank → mark as `skipped (missing category)` and continue. If unknown → abort: `ERROR: finding <ID> has unrecognized category '<value>'. Allowed: spec-fix, new-OQ, accepted-risk, out-of-scope, skipped.`
- **`Payload:`** — structure depends on category (see contracts in §3.5 above). If category-specific payload is missing or malformed (e.g. `spec-fix` without `Target:`, `new-OQ` without `OQ Text:`), abort with the specific finding ID and field name.

#### 4.3 — Historical-path classification

For every `spec-fix` (and any `new-OQ` / `accepted-risk` with explicit `Target:`) resolution, classify its `Target:` path:

| Path pattern | Historical? |
|---|---|
| `<feature_dir>/spec.md` | YES |
| `<feature_dir>/plan.md` | YES |
| `<feature_dir>/tasks.md` | YES |
| `<feature_dir>/research.md` | YES |
| `<feature_dir>/data-model.md` | YES |
| `<feature_dir>/contracts/*` | YES |
| `<feature_dir>/quickstart.md` | YES |
| `<feature_dir>/checklists/*` | YES |
| `.specify/memory/constitution.md` | No — always editable |
| `.specify/templates/*` | No — always editable |
| `<feature_dir>/analyze-findings-*.md` | No — session artifact, this skill owns it |
| any path under `99_Archive/*` | YES (and always refuse — even with the flag) |
| anything else (e.g. graduated forward-facing canonical specs) | No — always editable |

For each resolution whose target is `Historical = YES`:

- **Without `--allow-historical-edits`**: REFUSE the entire batch and abort with:

  ```
  ERROR: finding <ID> targets historical SpecKit working record <path>.
  These files serve as the audit trail of "what was decided at time T", and
  rewriting them destroys that audit trail.

  Options:
    1. Re-route the resolution: edit §3 Payload to target a forward-facing
       canonical doc, then re-run /analyzebatch --apply.
    2. Re-categorize as accepted-risk: record the gap on a forward-facing spec.
    3. If your project intentionally uses <feature_dir>/spec.md as the
       forward-facing canonical (no graduated docs tree), re-run with
       --allow-historical-edits to provide explicit pre-consent.

  No files were modified.
  ```

- **With `--allow-historical-edits`**: proceed (the flag is the maintainer's explicit pre-consent).
- **`99_Archive/*` is special — refuse even with the flag**.

> The historical-path rule mirrors the rule used by the spec-kit-red-team extension's apply command. Analyze frequently NEEDS to edit `<feature_dir>/spec.md` / `plan.md` / `tasks.md` — that's why the typical batch caller passes `--allow-historical-edits` by default.

#### 4.4 — Validation

Performed on the parsed resolutions before any file write:

- Every finding ID in §2 has a §3 block (already checked in §4.1).
- Every category is one of the 5 allowed values (already checked in §4.2).
- Every `spec-fix` has a `Target:` path that EXISTS on disk. If missing, abort: `ERROR: finding <ID> spec-fix targets <path> which does not exist. Either create the file first, or re-categorize as out-of-scope.`
- For `spec-fix`: the `Before:` snippet MUST exist verbatim in the target file. If not, abort: `ERROR: finding <ID> spec-fix Before-snippet not found in <target>. The target file may have changed since findings were drafted. Update the §3 Payload and re-run.`
- For `spec-fix`: `Before:` MUST appear exactly **once** in `Target:` (`grep -c -F` == 1). If multiple matches, abort with: `ERROR: finding <ID> Before-snippet matches <N> locations in <target>. Expand Before: with surrounding context until unique.`
- No two `spec-fix` resolutions touch overlapping line ranges in the same target. Detect by comparing target paths and `Before:` text overlap; abort if overlap detected.

#### 4.5 — Dry run (if `--dry-run`)

If `DRY_RUN = true`: after §4.4 validation succeeds, print the integration plan and STOP without writing anything:

```
DRY RUN — no files modified.
Findings file: <path>
Resolutions parsed: <N> total
  spec-fix: <N> (targets: <list of unique paths>)
  new-OQ: <N>
  accepted-risk: <N>
  out-of-scope: <N>
  skipped: <N>
Historical-edit consent: <granted | not granted>
Targets requiring historical-edit consent: <list, or "none">

Per-finding plan:
  D1: spec-fix → <target> (Before/After substitution)
  A1: new-OQ → <target> ## Open Questions (assigned OQ-<feature-id>-<NN>)
  ...
```

#### 4.6 — Batch apply (in-memory, then atomic write per file)

**Apply cadence (mirror of `/speckit-clarifybatch --apply`):** apply ALL parsed resolutions to in-memory copies of each touched file first, then perform validation again on the in-memory state, then write each modified file ONCE atomically. Do NOT save any file between resolutions.

For each finding's resolution, in §2 table order:

##### 4.6.1 `spec-fix`

- Load target file into in-memory map (cached if already loaded for a previous resolution this batch).
- Apply: replace the `Before:` snippet with the `After:` snippet (literal `target.replace(before, after, 1)`).
- Update findings-file §2 Status column for this ID → `spec-fix`.
- Append to §3 block: `Status: applied`, `Applied-at: <ISO timestamp>`, `Downstream-ref: <target path>`.

##### 4.6.2 `new-OQ`

- Resolve target spec — by default `<feature_dir>/spec.md`. If §3 Payload includes an explicit `Target:` line, use that (subject to §4.3 historical-path classification).
- Load target file in-memory.
- Ensure a `## Open Questions` section exists. If missing, create it just before any `## Accepted Risks` section, or at end of file.
- Determine next OQ ordinal: scan existing entries matching `OQ-<feature-id>-<NN>` and pick `<NN>+1` (zero-padded to 2 digits). If `<feature-id>` cannot be derived from the target path, fall back to the findings file's session ID's feature segment.
- Append: `- OQ-<feature-id>-<NN>: <OQ Text> (owner: <Owner>, blocks: <Blocks>)`.
- Update findings-file §2 Status → `new-OQ`.
- Append to §3 block: `Status: applied`, `Applied-at: <ISO timestamp>`, `Downstream-ref: OQ-<feature-id>-<NN>`.

##### 4.6.3 `accepted-risk`

- Resolve target spec (same logic as `new-OQ`).
- Load target file in-memory.
- Ensure a `## Accepted Risks` section exists. If missing, create it after `## Open Questions` (or at end of file).
- Determine next AR ordinal: scan for existing `AR-<NN>` entries and pick `<NN>+1` (zero-padded to 3 digits).
- Auto-detect `[regulatory-review]` tag: scan the §3 Rationale text and the original §2 finding description for any of: `money path`, `regulatory path`, `compliance`, `disclosure`, `KYC`, `AML`, `SEC`, `SFC`, `FCA`, `GDPR`. If matched AND `Tags:` line in payload does NOT already include `[regulatory-review]`, auto-add it.
- Append: `- AR-<NN>: <Rationale>` followed by ` <Tags>` if tags present.
- Update findings-file §2 Status → `accepted-risk`.
- Append to §3 block: `Status: applied`, `Applied-at: <ISO timestamp>`, `Downstream-ref: AR-<NN>`. If tag was auto-added, also include `Auto-tagged: [regulatory-review]`.

##### 4.6.4 `out-of-scope`

- Do NOT modify any spec / plan / tasks file (cross-reference only).
- Update findings-file §2 Status → `out-of-scope`.
- Append to §3 block: `Status: cross-referenced`, `Cross-reference: <Cross-reference value>`, `Applied-at: <ISO timestamp>`.

##### 4.6.5 `skipped`

- Do NOT modify any artifact.
- Update findings-file §2 Status → `skipped`.
- Append to §3 block: `Status: skipped`, `Reason: <Reason value, or "no reason given">`, `Applied-at: <ISO timestamp>`.

#### 4.7 — Atomic write

After ALL in-memory edits complete and §4.4 validation re-runs cleanly on the in-memory state:

1. Write each modified spec / plan / tasks file ONCE (single atomic write per file).
2. Write the findings file ONCE with all §2 Status updates and §3 block appends.
3. Update the findings file §5 Session Metadata YAML block — fill the `apply:` key:

   ```yaml
   apply:
     applied_at: <ISO timestamp>
     applied_by: <maintainer or agent name>
     resolutions:
       spec_fix: <count>
       new_OQ: <count>
       accepted_risk: <count>
       out_of_scope: <count>
       skipped: <count>
     unresolved: 0
     allow_historical_edits: <true | false>
     historical_edits_applied: <list of <ID>:<path>, or empty>
   ```

#### 4.8 — Archive findings file

- Compute timestamp: `YYYY-MM-DD-HHMMSS` (e.g. `2026-05-04-145900`).
- Rename `FINDINGS_FILE` → `<dirname>/analyze-findings-applied-<timestamp>.md`.
- Inside the renamed file, replace the `Status: PENDING` line with `Status: ARCHIVED`. Append `**Applied:** <timestamp>` directly underneath if not already present.

#### 4.9 — Report completion

Print:

```
APPLY phase complete.
Findings file (archived): <path to renamed file>
Resolutions applied: <N>
  spec-fix: <N> (touched: <list of paths>)
  new-OQ: <N>
  accepted-risk: <N>
  out-of-scope: <N>
  skipped: <N>
Files modified: <list>
```

Suggested next command: `/speckit-implement` (proceed to implementation).

### Behavior rules (apply across DRAFT and APPLY)

- If no meaningful findings (DRAFT): respond "No critical inconsistencies detected." Do NOT create `FINDINGS_FILE`. Suggest proceeding to `/speckit-implement`. Skip post-execution hooks (no artifact modified).
- If spec / plan / tasks file missing: instruct user to run the missing prerequisite. Do not create new artifacts here.
- Never exceed 50 findings; aggregate overflow in §5 metadata.
- Avoid duplicate findings: if a finding overlaps with an already-resolved item in `## Clarifications` / `## Open Questions` / `## Accepted Risks` of `spec.md`, drop it.
- Early termination signals ("stop", "done", "proceed") are no-ops — `/analyzebatch` has no per-turn loop.

Free-form focus context (after stripping flags): $ARGUMENTS

## Post-Execution Checks

**Check for extension hooks (after analysis)**:

> Fire these hooks ONLY when an artifact was modified in this run — i.e. APPLY phase. In DRAFT phase no spec / plan / tasks edit happened, so SKIP this section.

Check if `.specify/extensions.yml` exists in the project root.
- If it exists, read it and look for entries under the `hooks.after_analyze` key
- If the YAML cannot be parsed or is invalid, skip hook checking silently and continue normally
- Filter out hooks where `enabled` is explicitly `false`. Treat hooks without an `enabled` field as enabled by default.
- For each remaining hook, do **not** attempt to interpret or evaluate hook `condition` expressions:
  - If the hook has no `condition` field, or it is null/empty, treat the hook as executable
  - If the hook defines a non-empty `condition`, skip the hook and leave condition evaluation to the HookExecutor implementation
- When constructing slash commands from hook command names, replace dots (`.`) with hyphens (`-`). For example, `speckit.git.commit` → `/speckit-git-commit`.
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
