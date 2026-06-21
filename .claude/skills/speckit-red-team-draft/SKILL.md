---
name: speckit-red-team-draft
description: Run adversarial review of a functional spec and produce a structured
  findings report; STOP after the report is written (no interactive resolution walk).
  Use /speckit.red-team.apply to batch-integrate resolutions from the file. Mirrors
  /speckit.red-team.run §1-§6 verbatim — same args, same lens-dispatch behaviour.
compatibility: Requires spec-kit project structure with .specify/ directory
metadata:
  author: github-spec-kit
  source: red-team:commands/red-team-draft.md
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Pre-Execution Checks

**Check for extension hooks (before red team)**:
- Check if `.specify/extensions.yml` exists in the project root.
- If it exists, read it and look for entries under the `hooks.before_speckit_red_team_run` key (the extension's command-specific hook namespace — REUSED here, NOT `before_speckit_red_team_draft`. Reason: existing extensions register against the established `red_team_run` namespace; reusing it keeps gating behavior identical between `/speckit.red-team.draft` (batch) and `/speckit.red-team.run` (interactive).)
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

Goal: Run an adversarial review of a functional spec using project-configured lenses. Produce a structured findings report at `specs/<feature-id>/red-team-findings-<YYYY-MM-DD>[-NN].md`; **STOP after writing the report**. Do NOT enter the interactive per-finding resolution walk — that is `/speckit.red-team.run`'s job. The maintainer (or downstream automation) fills the file's Resolutions Log offline, then runs `/speckit.red-team.apply` to atomically integrate the resolutions.

**Schema references**: the lens catalog (`.specify/extensions/red-team/red-team-lenses.yml`) is scaffolded by `specify extension add red-team` from `config-template.yml` shipped with this extension. Customise it for your project's domain; minimal required shape is documented inline in §2 preconditions below. The findings-report format is enumerated in §6.5.

### Usage

```
/speckit.red-team.draft <target-spec-path> [--yes] [--lenses name1,name2,...] [--dry-run] [--session-suffix NN]
```

## 1. Invocation parsing

Parse `$ARGUMENTS` into:

- `<target-spec-path>` (positional, required): path relative to repo root of the functional spec to attack. Examples: `specs/<NNN-feature-slug>/spec.md` (SpecKit working record), or a project-specific canonical location for graduated specs (e.g. `04_Functional_Specs/<Component>_Functional_Spec_v0.1_DRAFT.md` in repos that use a graduated docs tree). Both are valid inputs.
- `--yes` (flag): auto-confirm the proposed lens selection when >5 lenses match triggers. Required for non-interactive / CI invocations.
- `--lenses <comma-separated-names>` (flag with value): explicit override of the lens set. Skips trigger-matching; runs exactly the listed lenses.
- `--dry-run` (flag): report which lenses would run and why, without dispatching adversary agents.
- `--session-suffix <NN>` (flag with value): override the session ID's trailing ordinal when multiple sessions occur on the same day.

If `$ARGUMENTS` is empty OR the target spec path is missing, print the fenced Usage block from §Outline above and STOP. Do NOT try to infer the target from context.

## 2. Preconditions check

Before dispatching any adversary, verify in order. Fail fast on the first failure.

1. **Target spec exists**. Resolve the given path relative to repo root. If not found, print: `ERROR: target spec not found at <path>` and STOP.
2. **Lens catalog exists** at `<repo-root>/.specify/extensions/red-team/red-team-lenses.yml`. If not found, print the error below and STOP:
   ```
   ERROR: no lens catalog at .specify/extensions/red-team/red-team-lenses.yml
   Minimal required shape:
     version: v1
     lenses:
       - name: <lens-name>
         description: <one-sentence description of the adversarial angle>
         core_questions:
           - <attack question 1>
           - <attack question 2>
         trigger_match: [<one or more of: money_path, regulatory_path, ai_llm, immutability_audit, multi_party, contracts>]
         severity_weight: <integer, default 5>    # optional
         finding_bound: <integer, default 5>       # optional
   Define at least 1 lens covering each trigger category your project cares about.
   ```
3. **Lens catalog parses**. Read the YAML. If parse fails, print: `ERROR: .specify/extensions/red-team/red-team-lenses.yml failed to parse: <error>` and STOP.
4. **Catalog non-empty**. If top-level `lenses` list is missing or empty, print: `ERROR: lens catalog has no lenses defined` and STOP.
5. **Each lens entry has required fields**: `name`, `description`, `core_questions`, `trigger_match`. Entries missing any of these are skipped with a warning — session proceeds on the remainder. If ALL entries are malformed, fail the catalog check.
6. **Project declares trigger criteria** (soft check — warn, don't fail). Read `<repo-root>/.specify/memory/constitution.md`. Search for a `## Red Team Trigger Criteria` section (or equivalent). If absent, print: `WARNING: constitution does not yet declare red team trigger criteria (expected at ## Red Team Trigger Criteria). Proceeding in bootstrap mode using the six default categories enumerated in the lens catalog schema.` and continue. The six default categories (money_path, regulatory_path, ai_llm, immutability_audit, multi_party, contracts) are used for §3 trigger matching. If `--lenses` was passed, trigger matching is bypassed entirely and this check is a no-op.

## 3. Trigger matching

Skip this section entirely if `--lenses` was passed (jump to §4 using the explicit list).

Otherwise:

1. **Read the target spec** content (full file).
2. **Scan for trigger evidence** against the six trigger categories:
   - `money_path` — keywords/patterns: fee, amount, $, currency, rate, allocation, commitment size, AUM, price, cost, transfer.
   - `regulatory_path` — keywords/patterns: KYC, AML, compliance, regulator, audit, GDPR, SEC, SFC, FCA, jurisdiction, kill filter, fee structure regulatory.
   - `ai_llm` — keywords/patterns: LLM, Claude, GPT, prompt, scoring, classification (when LLM-based), summary generation, hallucination.
   - `immutability_audit` — keywords/patterns: immutable, audit trail, permanent, never deleted, append-only, version preserved.
   - `multi_party` — keywords/patterns: partner, IC, approval, analyst, maintainer, role, authority, sign-off, gate.
   - `contracts` — keywords/patterns: upstream, downstream, API, interface, input from, output to, handoff, integration, document pipeline.
3. **Judgement call**: keyword presence is a heuristic. The final decision is the agent's — if the spec genuinely touches the concern described in the category, include it. If the keyword is incidental (e.g., "audit" in a non-audit sentence), exclude it.
4. **Emit matched-trigger list**. If zero triggers match AND `--lenses` was not passed, print: `INFO: target spec matches no trigger categories — no red team required. Pass --lenses to run voluntarily.` and STOP (not an error — this is the opt-in voluntary path working correctly).

## 4. Lens selection (propose-and-confirm)

Given the matched-triggers list (from §3) or explicit `--lenses` list (from §1):

### If explicit `--lenses` was passed

Resolve each name against the catalog. Unknown names produce a warning and are dropped. If all are dropped, fail with: `ERROR: none of the specified lenses exist in the catalog`. Otherwise proceed to §5 with the resolved list as `selected_lenses`.

### If trigger-matched

1. **Filter the catalog** to lenses where `trigger_match` intersects the matched-triggers list. Call this `matched_lenses`.
2. **If `len(matched_lenses) == 0`**: No lens in the catalog covers the matched triggers. Print: `ERROR: lens catalog has no lens covering the matched triggers <list>. Extend the catalog or pass --lenses explicitly.` and STOP.
3. **If `len(matched_lenses) <= 5`**: Use all of them as `selected_lenses` with `selection_method: auto`. Skip to §5.
4. **If `len(matched_lenses) > 5`**: Enter the propose-and-confirm flow:
   - **Rank** by: primary — count of overlapping trigger-matches with the spec's triggers (higher = preferred); tie-breaker — `severity_weight` from the catalog (higher = preferred); final tie-breaker — alphabetical by name.
   - **Propose the top 5** as the default selection.
   - **Show the maintainer**:
     - The matched-triggers list.
     - The proposed top-5 default with, for each, a one-line rationale (which triggers it covers + severity_weight).
     - The dropped lenses with the reason they ranked below.
   - **If `--yes` was passed**: auto-accept the proposed default. Set `selection_method: auto` in the session record with a note that --yes was used. Skip to §5.
   - **Otherwise** (no `--yes`): prompt the maintainer to respond:
     - "accept" / "yes" → use proposed default; `selection_method: proposed-and-confirmed`.
     - "swap A for B" → swap a default lens with a dropped lens; `selection_method: swapped`.
     - "expand to N" (N > 5) → run more than 5 lenses (maintainer opts into the cost); `selection_method: expanded`.
     - Anything else → re-prompt with the three options above.

     *(CI / batch runs MUST pass `--yes` to auto-accept the proposed default; running without `--yes` in a non-interactive context will stall waiting for input. This keeps the behavior simple: interactivity is determined by whether `--yes` was passed, not by detecting the terminal.)*

Write the final `selected_lenses` list. Validate 3 ≤ `len(selected_lenses)` ≤ 5 (unless `selection_method == expanded`). If below 3, warn the maintainer that lens diversity is weak — offer to abort.

## 5. Parallel adversary dispatch

### If `--dry-run` was passed

Print:
```
DRY RUN — no agents dispatched.
Target: <target-spec-path>
Matched triggers: <list>
Selected lenses: <list>
Selection method: <method>
Proposed session ID: RT-<feature-id>-<YYYY-MM-DD>[-<NN>]
```
and STOP.

### Otherwise

1. **Compute session ID**: `RT-<feature-id>-<YYYY-MM-DD>[-<NN>]` where `<feature-id>` is derived from the target path (e.g., `<NNN-feature-slug>` from `specs/<NNN-feature-slug>/spec.md`, or the containing feature when attacking a graduated spec — best-effort match; if ambiguous, derive from the filename).
2. **Build adversary-agent prompts**. For each selected lens, construct a prompt with:
   - The lens's `description`.
   - The lens's `core_questions` as the attack brief.
   - The target spec file path (the agent reads it directly).
   - Supporting context paths (if the target is a graduated spec, automatically include its SpecKit working directory — `specs/<feature-id>/plan.md`, `tasks.md`, `contracts/` — if present).
   - Instruction: return ≤`finding_bound` findings ranked by severity (CRITICAL > HIGH > MEDIUM > LOW), each with: location in the spec (section or FR ref), 1-4 sentence finding description, 1-2 sentence suggested resolution.
   - Output format: strict JSON or fenced-code markdown table so aggregation is deterministic.
3. **Dispatch all adversary agents in a single parallel batch** using the host agent's sub-agent / task-dispatch primitive (e.g., Claude Code's Agent tool). All calls go in the same tool-use message so they run concurrently.
4. **Record per-lens start/end times** for wall-clock tracking. Project-level success criteria SHOULD target under 30 minutes for a mid-sized functional spec (roughly 500 lines, 4–6 user stories, 20–30 FRs). Larger specs warrant a proportionally larger budget.

## 6. Findings aggregation

Collect the responses from all dispatched agents.

1. **Parse each response** into structured findings per the findings-report schema:
   - `id`: assigned here — format `F-<session_id>-<NNN>` zero-padded ordinal, monotonic across the whole session.
   - `lens`: name of originating lens.
   - `severity`: one of CRITICAL / HIGH / MEDIUM / LOW.
   - `location`: section or FR reference in the target spec.
   - `description`: the finding.
   - `suggested_resolution`: adversary's proposed fix.
   - `status`: blank (filled by `/speckit.red-team.apply` after the maintainer fills the Resolutions Log offline).
2. **Enforce per-lens finding bound**. For each lens, retain only the top `finding_bound` findings by severity (default 5 per catalog). Drop the rest. Record dropped count in session metadata.
3. **Detect and handle lens failures**. If an agent returned no findings, returned an error, or the response could not be parsed:
   - Record the failure in session metadata with the lens name and reason.
   - Continue with other lenses — do NOT abort the session.
   - Flag the failed lens as a candidate for `--lenses <name>` re-run after refinement.
4. **Build the aggregated findings table** in markdown. Sort globally by severity descending (CRITICAL → HIGH → MEDIUM → LOW) so all CRITICAL findings appear at the top regardless of which lens raised them. Within each severity band, sort by lens name (alphabetic) for deterministic ordering, then by the order returned by that lens's adversary agent. Severity values are the canonical CRITICAL / HIGH / MEDIUM / LOW set defined in §5.
5. **Write the initial report file** at `specs/<feature-id>/red-team-findings-<YYYY-MM-DD>[-NN].md` with:
   - Header block (session ID, target, date, maintainer, lenses, selection method, supporting context, wall-clock)
   - §1 Session Summary: placeholder for maintainer to fill post-review.
   - §2 Findings table: fully populated.
   - §3 Resolutions Log: empty stubs per finding ID. Each stub MUST include a `Category:` line (blank value), and a `Payload:` block (blank — for `spec-fix`: target path + diff; for `new-OQ`: OQ text + owner + what it blocks; for `accepted-risk`: rationale + optional regulatory tag; for `out-of-scope`: cross-reference target). The maintainer (or downstream automation) fills these offline before running `/speckit.red-team.apply`.

     **`spec-fix` payload contract (CRITICAL — apply enforces this at §5)**:

     ```
     ### F-RT-...-NNN
       Category: spec-fix
       Payload:
       Target: <path relative to repo root>
       Before: <verbatim substring of Target file — literal text, copied as-is>
       After:  <intended replacement of that exact substring>
     ```

     Rules:
     - `Before:` MUST be **literal text** copied from `Target:`. Apply runs `target.replace(before, after)` — no LLM interpretation. Paraphrases, summaries, or directive prose ("Add an FR requiring …", "FR-X is missing …") will fail apply's §5 validation with `Before-snippet not found in <target>`.
     - `Before:` MUST appear exactly **once** in `Target:`. Verify with `grep -c -F "<Before>" <Target>` → must equal `1`. Expand the snippet with surrounding context if it appears multiple times.
     - `After:` MUST be the new text that should appear in the file at that exact location after apply.
     - Why this contract: deterministic output across reruns and CI. The same findings file must produce the same `Target:` mutation every time. Embedding a "fix me" directive defers interpretation to apply-time, which would break determinism and audit replay.

     Stub template the maintainer/respond automation MUST follow per category:

     ```
     ### F-RT-...-NNN
       Category: spec-fix
       Payload:
       Target: <path>
       Before: <verbatim substring>
       After:  <replacement>

     ### F-RT-...-NNN
       Category: new-OQ
       Payload:
       OQ Text: <one paragraph open question>
       Owner:   <name or role>
       Blocks:  <what this blocks until answered>

     ### F-RT-...-NNN
       Category: accepted-risk
       Payload:
       Rationale: <one paragraph why we accept this>
       Tags:      [regulatory-review]   # optional; auto-added if Rationale matches money/regulatory/compliance/disclosure/KYC/AML/SEC/SFC/FCA/GDPR

     ### F-RT-...-NNN
       Category: out-of-scope
       Payload:
       Cross-reference: <future spec ID or path>
       Reason:          <why deferred>

     ### F-RT-...-NNN
       Category: skipped
       Payload:
       Reason: <optional one-liner>
     ```
   - §4 Validation Decision: include ONLY if this is a designated dogfood session (a first-run validation of the protocol against a real project spec; the target spec for a given project is declared in that project's constitution or extension-adoption docs).
   - §5 Session metadata YAML block per the session-record schema.
6. **Announce completion**: print summary (count by lens, count by severity, path to report) and transition to §7.

## 7. STOP — Findings file ready for batch resolution

Findings file written at `specs/<feature-id>/red-team-findings-<YYYY-MM-DD>[-NN].md` with §2 Status column blank and §3 Resolutions Log empty stubs.

**DO NOT enter the per-finding resolution walk.** That is `/speckit.red-team.run`'s interactive responsibility. This `/speckit.red-team.draft` command stops here.

The maintainer (or downstream automation, e.g. an Archon `red-team-respond` node) fills the file offline:
- §2 Status column → category per finding ID (`spec-fix` / `new-OQ` / `accepted-risk` / `out-of-scope`).
- §3 Resolutions Log → payload per finding ID (diff for `spec-fix`, OQ text for `new-OQ`, rationale for `accepted-risk`, cross-reference for `out-of-scope`).

Then runs:

```
/speckit.red-team.apply <findings-path> [--allow-historical-edits] [--dry-run]
```

`/speckit.red-team.apply` parses the file, validates resolutions, applies them atomically per category (mirror of `/speckit-clarifybatch --apply` for red-team), and archives the findings file.

**Print to the user:**

```
DRAFT phase complete.
Findings file: <relative path to findings file>
Findings: N total — <count by severity>
Selected lenses: <list>
Wall-clock: <duration>

Next step: review and fill §3 Resolutions Log per finding ID, then run:
  /speckit.red-team.apply <findings-path>
```

**Do NOT modify any spec file in this command.** The findings file is the only artefact written by `/speckit.red-team.draft`.

## 8. Failure-mode handling

| Condition | Behavior |
|---|---|
| Target spec missing | Fail fast with `ERROR: target spec not found at <path>`. No session created. |
| Lens catalog missing | Fail fast with the minimal-required-shape error printed in §2.2 above (no external doc references). |
| Catalog unparseable | Fail fast with `ERROR: .specify/extensions/red-team/red-team-lenses.yml failed to parse: <error>`. |
| Catalog empty (no `lenses` list) | Fail fast with `ERROR: lens catalog has no lenses defined`. |
| Individual lens entry malformed | Warn, skip that lens, proceed with the rest. If ALL entries malformed, fail. |
| Constitution lacks trigger criteria | Warn and proceed in bootstrap mode using the six default categories. UNLESS `--lenses` was passed (bypass). |
| Target spec matches zero triggers AND no `--lenses` | Print info message and STOP. Not an error. |
| No lens in catalog covers matched triggers | Fail fast — asks maintainer to extend catalog or pass --lenses. |
| >5 matches without `--yes` | Prompt the maintainer for accept / swap / expand. CI / batch runs MUST pass `--yes` to auto-accept the proposed default; otherwise the run will stall waiting for input. |
| Individual adversary agent fails (timeout, parse error, empty response) | Record failure in session metadata with lens name + reason. Continue with other lenses. Flag for re-run via `--lenses`. Do NOT abort the session. |
| Overwhelming findings (≥25 HIGH+CRITICAL combined after aggregation) | After §6 completes, if the combined count of HIGH and CRITICAL findings meets or exceeds **25**, warn the maintainer the spec may not be ready for red team and offer an abort path. Abort records session state for later resumption. |
| Spec was updated since prior red team | On session start, check for prior findings report in the feature dir. If present and older than a material-change threshold (heuristic: target spec has new FRs or section count changed), warn the maintainer and ask whether to proceed or abort. |
| Findings file already exists for today (same `<feature-id>`/`<date>`) and is unarchived | Warn and either offer to use `--session-suffix NN` to disambiguate, or to overwrite (after confirmation). Never silently clobber. |

All fail-fast conditions MUST produce actionable error messages — naming the file, the expected location, and pointing at the README or architecture doc for recovery.