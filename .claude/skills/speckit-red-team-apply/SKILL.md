---
name: speckit-red-team-apply
description: Batch-mode red-team integration — parse a filled findings report and
  atomically apply each resolution to its forward-facing spec (or, with --allow-historical-edits,
  to historical SpecKit working records). Mirror of /speckit-clarifybatch --apply
  for red-team. Pair with /speckit.red-team.draft (which produces the findings file).
compatibility: Requires spec-kit project structure with .specify/ directory
metadata:
  author: github-spec-kit
  source: red-team:commands/red-team-apply.md
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty). The input may contain a positional `<findings-path>` AND/OR mode flags (`--allow-historical-edits`, `--dry-run`).

## Pre-Execution Checks

**Check for extension hooks (before red team)**:
- Check if `.specify/extensions.yml` exists in the project root.
- If it exists, read it and look for entries under the `hooks.before_speckit_red_team_run` key (the extension's command-specific hook namespace — REUSED here, NOT `before_speckit_red_team_apply`. Reason: existing extensions register against the established `red_team_run` namespace; reusing it keeps gating behavior identical between `/speckit.red-team.apply` (batch) and `/speckit.red-team.run` (interactive).)
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

## Outline

Goal: Take a filled findings report (produced by `/speckit.red-team.draft` and resolved offline by the maintainer) and atomically apply each resolution to its target file. Mirror of `/speckit-clarifybatch --apply` for red-team — single atomic write per modified file, then archive the findings file.

This command performs the integration phase that `/speckit.red-team.run` does inline (its §7 interactive walk). The split exists so automation pipelines (e.g. Archon's `red-team-respond` → `red-team-gate` → `red-team-apply` flow) can do the resolution drafting and gate-approval out-of-band, then call `/speckit.red-team.apply` to commit the result deterministically without a chat-text RECAP round-trip.

### Usage

```
/speckit.red-team.apply [<findings-path>] [--allow-historical-edits] [--dry-run]
```

| Argument | Required | Description |
|---|---|---|
| `<findings-path>` | No | Path (relative to repo root) to the findings file. If omitted, glob `specs/<feature-id>/red-team-findings-*.md` and pick the MOST RECENT unarchived file (ignore filenames containing `-applied-`). |
| `--allow-historical-edits` | No | Explicit pre-consent for editing historical SpecKit working records (`specs/<feature-id>/{spec,plan,tasks,research,data-model}.md`, `contracts/`, `quickstart.md`, `checklists/`). Without this flag, attempts to apply `spec-fix` resolutions targeting those paths REFUSE. Use only in projects that intentionally use `specs/<feature-id>/spec.md` as the forward-facing canonical spec (no graduated docs tree). |
| `--dry-run` | No | Parse the findings file, validate, and print the plan (per-finding action + target file + classification) WITHOUT writing any file. |

## 1. Invocation parsing

Parse `$ARGUMENTS`:

1. Extract `--allow-historical-edits` flag (boolean).
2. Extract `--dry-run` flag (boolean).
3. The remaining non-flag token (if any) is `<findings-path>`. If multiple non-flag tokens remain, abort with: `ERROR: /speckit.red-team.apply takes at most one positional argument. Got: <args>`.
4. If `<findings-path>` is omitted: resolve the active feature directory (scan `.specify/feature.json` for `feature_directory`, or fall back to globbing `specs/*` for the most recently modified directory containing a `spec.md`). Then glob `<feature_directory>/red-team-findings-*.md` and pick the MOST RECENT file whose filename does NOT contain `-applied-`. If none found, abort with: `ERROR: no unarchived findings file found in <feature_directory>. Run /speckit.red-team.draft first.`

## 2. Findings file validation

Open `<findings-path>` and verify:

1. **File exists and is readable**. Otherwise abort: `ERROR: findings file not found at <path>`.
2. **Not already archived**. If filename contains `-applied-` OR the file's metadata block contains `Status: ARCHIVED`, abort: `ERROR: findings file already archived: <path>. Nothing to apply.`
3. **§2 Findings table present**. Locate a markdown table whose header row matches `| ID | Lens | Severity | Location |` (the structure produced by `/speckit.red-team.draft` §6). Extract every data row keyed by `ID` (e.g. `F-RT-...-001`). If the table is missing or has no data rows, abort: `ERROR: findings file <path> contains no §2 Findings table or no findings rows.`
4. **§3 Resolutions Log present**. Locate the `## 3. Resolutions Log` heading (or equivalent — accept `## §3 Resolutions Log`, `### Resolutions Log`, etc. for tolerance). For every finding ID in §2, verify a corresponding block exists in §3. Missing blocks are an error: `ERROR: §3 Resolutions Log missing block for finding <ID>.`
5. **§5 Session Metadata YAML present**. Locate the YAML fenced block under §5. If missing, warn but continue (apply will append a metadata stanza on completion).

## 3. Parse resolutions

For each finding ID, extract from its §3 block:

- **`Category:`** — one of `spec-fix` / `new-OQ` / `accepted-risk` / `out-of-scope` / `skipped`.
- **`Payload:`** — the resolution payload, structure depends on category:
  - `spec-fix`: a `Target:` line (path relative to repo root) and a fenced diff/patch block (or `Before:`/`After:` snippet pair). The maintainer is responsible for the diff being correct; this command applies it verbatim.

    **Literal-substring contract (CRITICAL — enforced at §5):**
    - `Before:` MUST be a **verbatim substring** of the `Target:` file — literal text copied from the file, NOT a paraphrase, summary, or directive describing what's missing.
    - `After:` MUST be the intended replacement of that exact `Before:` substring (so apply can do `target.replace(before, after)` mechanically).
    - The `Before:` substring MUST appear exactly **once** in the `Target:` file. Verify with `grep -c -F "<Before>" <Target>` → must equal `1`. If the snippet appears multiple times, expand `Before:` with surrounding context until unique.
    - Apply does NOT call an LLM to interpret directives. Prose like `Before: FR-X is missing the cancellation rule` or `After: Add an FR requiring …` will fail §5 validation with `Before-snippet not found in <target>`.
    - Why: deterministic outputs across reruns and CI. If apply LLM-interpreted directives, the same findings file would produce different `Target:` outputs across runs, destroying the audit trail.

    **WRONG (directive — will fail §5):**
    ```
    Before: FR-021 is missing a result-subtype mapping for max_tokens.
    After:  Add a row stating max_tokens maps to error_during_execution.
    ```

    **RIGHT (verbatim substring — passes §5):**
    ```
    Before: | error_during_execution | runtime errors | errors[0] populated |
    After:  | error_during_execution | runtime errors, max_tokens, model_context_window_exceeded | errors[0] populated |
    ```
  - `new-OQ`: an `OQ Text:` block (one paragraph) + `Owner:` line + `Blocks:` line.
  - `accepted-risk`: a `Rationale:` block (one paragraph) + optional `Tags:` line (e.g. `[regulatory-review]`). Auto-tag `[regulatory-review]` if Rationale or finding description mentions: money path, regulatory path, compliance, disclosure, KYC/AML/SEC/SFC/FCA/GDPR.
  - `out-of-scope`: a `Cross-reference:` line (path or spec ID) + `Reason:` line.
  - `skipped`: optional `Reason:` line. No further payload required.

Resolve each parsed entry:

- If `Category:` is missing or blank → mark as `skipped (missing category)`.
- If `Category:` is unknown → abort: `ERROR: finding <ID> has unrecognized category '<value>'. Allowed: spec-fix, new-OQ, accepted-risk, out-of-scope, skipped.`
- If category-specific payload is missing or malformed (e.g. `spec-fix` without `Target:`, `new-OQ` without `OQ Text:`) → abort with the specific finding ID and field name.

## 4. Historical-path classification

For every `spec-fix` resolution, classify its `Target:` path against the historical-paths table (verbatim from `commands/red-team.md` §7 hard-and-fast rule):

| Path pattern | Category | Historical? |
|---|---|---|
| `04_Functional_Specs/*` (or project-equivalent graduated docs tree) | Forward-facing canonical spec | No — always editable |
| `03_Product_Requirements/PRD_*` | Forward-facing canonical spec | No — always editable |
| `02_System_Architecture/*` | Forward-facing canonical spec | No — always editable |
| `01_Business_Overview/*` | Forward-facing canonical spec | No — always editable |
| `.specify/memory/constitution.md` | Forward-facing governance | No — always editable |
| `.specify/templates/*` | Forward-facing tooling config | No — always editable |
| `specs/<feature-id>/spec.md` | **HISTORICAL SpecKit working record** | **YES** |
| `specs/<feature-id>/plan.md` | **HISTORICAL SpecKit working record** | **YES** |
| `specs/<feature-id>/tasks.md` | **HISTORICAL SpecKit working record** | **YES** |
| `specs/<feature-id>/research.md` | **HISTORICAL SpecKit working record** | **YES** |
| `specs/<feature-id>/data-model.md` | **HISTORICAL SpecKit working record** | **YES** |
| `specs/<feature-id>/contracts/*` | **HISTORICAL SpecKit working record** | **YES** |
| `specs/<feature-id>/quickstart.md` | **HISTORICAL SpecKit working record** | **YES** |
| `specs/<feature-id>/checklists/*` | **HISTORICAL SpecKit working record** | **YES** |
| `specs/<feature-id>/red-team-findings-*.md` | Session artifact (this skill owns it) | No — always editable |
| `99_Archive/*` | Archived historical | **YES (and always refuse — even with the flag)** |

For each `spec-fix` whose target is `Historical = YES`:

- **Without `--allow-historical-edits`**: REFUSE the entire batch and abort with:
  ```
  ERROR: finding <ID> targets historical SpecKit working record <path>.
  /speckit.red-team.run §7 default-refuses edits to historical paths because they
  serve as the audit trail of "what was decided at time T" and rewriting them
  destroys that audit trail.
  Options:
    1. Re-route the resolution: edit §3 Payload to target a forward-facing
       canonical doc (04_Functional_Specs/, 03_Product_Requirements/, etc.),
       then re-run /speckit.red-team.apply.
    2. Re-categorize as accepted-risk: record the gap on a forward-facing spec.
    3. If your project intentionally uses specs/<feature-id>/spec.md as the
       forward-facing canonical (no graduated docs tree), re-run with
       --allow-historical-edits to provide explicit pre-consent.
  No files were modified.
  ```
- **With `--allow-historical-edits`**: proceed (the flag is the maintainer's explicit pre-consent satisfying §7's consent-first rule for these paths).
- **`99_Archive/*` is special — refuse even with the flag**. Archive paths are immutable by definition; if a resolution targets `99_Archive/*`, abort regardless of the flag.

## 5. Validation

Performed on the parsed resolutions before any file write:

- Every finding ID in §2 has a §3 block (already checked in §2 above).
- Every category is one of the 5 allowed values (already checked in §3).
- Every `spec-fix` has a `Target:` path that EXISTS on disk (otherwise `spec-fix` would create a new file, which is an error — use `out-of-scope` to point at a future spec instead). If a target file is missing, abort: `ERROR: finding <ID> spec-fix targets <path> which does not exist. Either create the file first, or re-categorize as out-of-scope.`
- For `spec-fix` diffs: the `Before:` snippet (or first hunk of the diff) MUST exist verbatim in the target file. If not, abort with `ERROR: finding <ID> spec-fix Before-snippet not found in <target>. The target file may have changed since the findings file was drafted. Update the §3 Payload and re-run.`
- No two `spec-fix` resolutions touch overlapping line ranges in the same target (basic conflict detection — if two resolutions both want to edit the same lines, the second one's `Before:` snippet won't match after the first applies). Detect by comparing target paths and `Before:` text overlap; abort if overlap detected.

## 6. DRY RUN — print plan and STOP

If `--dry-run` was passed: after §3-§5 validation succeeds, print the integration plan and STOP without writing anything:

```
DRY RUN — no files modified.
Findings file: <path>
Resolutions parsed: N total
  spec-fix: N (targets: <list of unique target paths>)
  new-OQ: N
  accepted-risk: N
  out-of-scope: N
  skipped: N
Historical-edit consent: <granted | not granted (default refuse)>
Targets requiring historical-edit consent: <list, or "none">

Per-finding plan:
  F-...-001: spec-fix → <target> (<lines added>/<lines removed>)
  F-...-002: new-OQ → <target> ## Open Questions (assigned OQ-<feature-id>-<NN>)
  F-...-003: accepted-risk → <target> ## Accepted Risks (assigned AR-<NN>)
  F-...-004: out-of-scope → cross-reference only
  F-...-005: skipped (Reason: <text>)
```

## 7. Batch apply (in-memory, then atomic write per file)

**Apply cadence (mirror of `/speckit-clarifybatch --apply` Step 4):** apply ALL parsed resolutions to in-memory copies of each touched file first, then perform validation, then write each modified file ONCE atomically. Do NOT save any file between resolutions.

For each finding's resolution, in §2 table order:

### 7.1 `spec-fix`

- Load target file into in-memory map (cached if already loaded for a previous resolution this batch).
- Apply the diff: replace the `Before:` snippet with the `After:` snippet (or apply the unified-diff hunk verbatim).
- Update findings-file §2 Status column for this ID → `spec-fix`.
- Append to §3 Resolutions Log block: `Status: applied`, `Applied-at: <ISO timestamp>`, `Downstream-ref: <target path>:<line range>`.

### 7.2 `new-OQ`

- Resolve target spec — by default the same `<feature-id>/spec.md`. If §3 Payload includes an explicit `Target:` line, use that (subject to §4 historical-path classification — same flag rule applies; `new-OQ` to a historical path requires `--allow-historical-edits`).
- Load target file in-memory.
- Ensure a `## Open Questions` section exists. If missing, create it just before any `## Accepted Risks` section, or at the end of the file if neither exists.
- Determine next OQ ordinal: scan existing entries matching `OQ-<feature-id>-<NN>` and pick `<NN>+1` (zero-padded to 2 digits). If `<feature-id>` cannot be derived from the target path, fall back to the findings file's session ID's feature segment.
- Append: `- OQ-<feature-id>-<NN>: <OQ Text> (owner: <Owner>, blocks: <Blocks>)`.
- Update findings-file §2 Status column → `new-OQ`.
- Append to §3 Resolutions Log: `Status: applied`, `Applied-at: <ISO timestamp>`, `Downstream-ref: OQ-<feature-id>-<NN>`.

### 7.3 `accepted-risk`

- Resolve target spec (same logic as `new-OQ`).
- Load target file in-memory.
- Ensure a `## Accepted Risks` section exists. If missing, create it after `## Open Questions` (or at end of file).
- Determine next AR ordinal: scan for existing `AR-<NN>` entries and pick `<NN>+1` (zero-padded to 3 digits — convention from native `/speckit.red-team.run` §7).
- Auto-detect `[regulatory-review]` tag: scan the §3 Rationale text and the original §2 finding description for any of: `money path`, `regulatory path`, `compliance`, `disclosure`, `KYC`, `AML`, `SEC`, `SFC`, `FCA`, `GDPR`. If matched AND `Tags:` line in payload does NOT already include `[regulatory-review]`, auto-add it.
- Append: `- AR-<NN>: <Rationale>` followed by ` <Tags>` if tags present.
- Update findings-file §2 Status → `accepted-risk`.
- Append to §3 Resolutions Log: `Status: applied`, `Applied-at: <ISO timestamp>`, `Downstream-ref: AR-<NN>`. If a tag was auto-added, also include `Auto-tagged: [regulatory-review]` for traceability.

### 7.4 `out-of-scope`

- Do NOT modify any spec file (cross-reference only — per `/speckit.red-team.run` §7.2 `out-of-scope` rule).
- Update findings-file §2 Status → `out-of-scope`.
- Append to §3 Resolutions Log: `Status: cross-referenced`, `Cross-reference: <Cross-reference value from payload>`, `Applied-at: <ISO timestamp>`.

### 7.5 `skipped`

- Do NOT modify any spec file.
- Update findings-file §2 Status → `skipped`.
- Append to §3 Resolutions Log: `Status: skipped`, `Reason: <Reason value from payload, or "no reason given">`, `Applied-at: <ISO timestamp>`.

## 8. Atomic write

After ALL in-memory edits complete and §5 validation re-runs cleanly on the in-memory state:

1. Write each modified spec file ONCE (single atomic `Write` call per file).
2. Write the findings file ONCE with all §2 Status updates and §3 Resolutions Log appends.
3. Update the findings file §5 Session Metadata YAML block with:
   ```yaml
   apply:
     applied_at: <ISO timestamp>
     applied_by: <maintainer>
     resolutions:
       spec_fix: <count>
       new_OQ: <count>
       accepted_risk: <count>
       out_of_scope: <count>
       skipped: <count>
     unresolved: 0    # or N if any resolutions failed validation and user opted to skip them
     allow_historical_edits: <true | false>
     historical_edits_applied: <list of <ID>:<path> for applied historical edits, or empty>
   ```

## 9. Archive findings file

- Compute timestamp: `YYYY-MM-DD-HHMMSS` (e.g. `2026-05-04-145900`).
- Rename `<findings-path>` → `<dirname>/red-team-findings-applied-<timestamp>.md` (mirror of `clarifybatch`'s `clarifications-applied-<timestamp>.md` archive convention).
- Inside the renamed file, replace any `Status: PENDING` line in the header with `Status: ARCHIVED`. Append `**Applied:** <timestamp>` directly underneath if not already present.

## 10. Report completion

Print:

```
APPLY phase complete.
Findings file (now archived): <new archive path>
Resolutions applied: N total
  spec-fix: N → files touched: <list>
  new-OQ: N → assigned IDs: <list>
  accepted-risk: N → assigned IDs: <list>
  out-of-scope: N (cross-references only, no spec writes)
  skipped: N
Historical-edit consent used: <yes | no>
Auto-tagged [regulatory-review]: <count>

Suggested next command: /speckit.plan
```

## 11. Failure-mode handling

| Condition | Behavior |
|---|---|
| Findings file not found | Fail fast with `ERROR: findings file not found at <path>`. No file modified. |
| Findings file already archived | Fail fast: `ERROR: findings file already archived: <path>. Nothing to apply.` |
| §2 Findings table missing or empty | Fail fast: `ERROR: findings file <path> contains no §2 Findings table or no findings rows.` |
| §3 block missing for a finding ID | Fail fast: `ERROR: §3 Resolutions Log missing block for finding <ID>.` |
| §3 block has unrecognized `Category:` | Fail fast with the specific finding ID + invalid value + list of allowed values. |
| §3 block missing category-specific payload field | Fail fast with finding ID + missing field name. |
| `spec-fix` `Target:` does not exist on disk | Fail fast: `ERROR: finding <ID> spec-fix targets <path> which does not exist.` |
| `spec-fix` `Before:` snippet not found in target | Fail fast: `ERROR: finding <ID> spec-fix Before-snippet not found in <target>. The target file may have changed since the findings file was drafted.` |
| Two `spec-fix` resolutions overlap (same target, same lines) | Fail fast with both finding IDs. No files modified. |
| `spec-fix` targets a historical SpecKit path AND no `--allow-historical-edits` | REFUSE entire batch with §4 error message. |
| `spec-fix` targets `99_Archive/*` | REFUSE entire batch — flag does not bypass this. |
| Auto-tag heuristic matched but maintainer's `Tags:` already excludes `[regulatory-review]` (e.g. `[skip-regulatory-review]` annotation) | Skip the auto-tag, log a warning to the apply report. (Maintainer override wins.) |
| Mid-write filesystem error | Atomic-write means partial state is impossible per file. If one file's write fails, the in-memory batch is preserved in the findings file's §3 (so the maintainer can see what was planned), and the apply phase aborts with the failed-file path. The findings file is NOT archived in this case (re-runnable). |
| `<findings-path>` omitted AND no unarchived file in active feature dir | Fail fast: `ERROR: no unarchived findings file found in <feature_directory>. Run /speckit.red-team.draft first.` |
| `<findings-path>` omitted AND no active feature directory resolvable | Fail fast: `ERROR: cannot resolve active feature directory. Pass <findings-path> explicitly.` |

All fail-fast conditions MUST produce actionable error messages — naming the finding ID, the target path, the specific field, and pointing at the §3 Payload format defined in §3 above for recovery.