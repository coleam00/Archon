---
description: Synthesize the maintainer's morning standup brief from gathered git/PR/issue/state data
argument-hint: (no arguments — all context provided via upstream nodes)
---

# Maintainer Standup Synthesis

You are producing a daily maintainer briefing for the Archon project. The user is the maintainer running this workflow. Your job is to read the gathered facts, cross-reference against the project's direction document and the maintainer's profile, and produce a prioritized brief plus state to persist for tomorrow's run.

**Workflow ID**: $WORKFLOW_ID

---

## Output format (read this FIRST, follow exactly)

Your response must be exactly two parts in order:

1. **Brief markdown** — starting with the literal line `# Maintainer Standup — YYYY-MM-DD` and continuing through the brief.
2. **State JSON block** — delimited by `ARCHON_STATE_JSON_BEGIN` and `ARCHON_STATE_JSON_END`, each on its own line, with valid JSON between them.

**Hard rules:**

- Start the response with the `#` heading. No prose preamble. No "Looking at the data...", no `<thinking>`, no analysis dump, no "Now I'll synthesize...".
- Do NOT wrap the response in a JSON object. Specifically: do NOT output `{"brief_markdown": "...", "next_state": {...}}` — that is the OLD contract and is wrong.
- Do NOT use markdown code fences around the `ARCHON_STATE_JSON_BEGIN`/`ARCHON_STATE_JSON_END` markers — the markers must be plain lines.
- Nothing after the closing marker. The closing marker is the last line of your response.

**Skeleton example** (illustrative — your actual brief uses real content):

```
# Maintainer Standup — 2026-04-29

## Since last run
- ...

## P1 — Do today
- **PR #N** — ...

ARCHON_STATE_JSON_BEGIN
{"last_run_at":"2026-04-29T07:00:00Z","last_dev_sha":"abc123","carry_over":[],"observed_prs":[{"number":1,"title":"x"}],"observed_issues":[],"direction_questions":[]}
ARCHON_STATE_JSON_END
```

(In your real output the markers and JSON are NOT inside a code fence.)

---

## Phase 1: LOAD INPUTS

You have three sources of upstream context, all already gathered. Each is a JSON string that you should parse.

### Git status (origin/dev movement since last run)

```
$git-status.output
```

Fields: `current_dev_sha`, `prior_dev_sha`, `current_branch`, `is_dirty`, `pull_status`, `new_commits`, `diff_stat`.

### GitHub data (PRs, issues, review requests, recently closed)

```
$gh-data.output
```

Fields: `gh_handle`, `since_date`, `all_open_prs`, `review_requested`, `authored_by_me`, `issues_assigned`, `recent_unlabeled_issues`, `recently_closed_prs`, `recently_closed_issues`, `my_recent_commits`, `replies_since_last_run`.

`replies_since_last_run` is an array of `{ number, kind, comments }` grouping contributor replies on PRs and issues since the last run. `kind` is one of `issue` / `pr_conversation` / `pr_review`; the maintainer's own comments are filtered out. Use this as the source for the **"Replies waiting on you"** brief section (see Phase 3).

### Local context (direction doc, maintainer profile, prior state, recent briefs)

```
$read-context.output
```

Fields: `direction` (markdown string), `profile` (markdown string), `prior_state` (object or null), `recent_briefs` (array of `{date, content}`), `today` (`YYYY-MM-DD`), `deadline_3d` (`YYYY-MM-DD`), `reviewed_prs` (map of PR number → `{ reviewed_at, gate_verdict, run_id }` recording past maintainer-review-pr runs — see Phase 2h).

---

## Phase 2: ANALYZE

### 2a. Detect first-run vs ongoing

If `prior_state` is `null` and `recent_briefs` is empty, this is a **first run**. Skip "Since last run" comparisons; produce a baseline triage and state snapshot the next run can diff against.

### 2b. Compare prior state to current reality (progress detection)

When `prior_state` exists:

- **Resolved since last run**: PRs in `prior_state.observed_prs` whose numbers do NOT appear in current `gh-data.output.all_open_prs` — they were closed or merged. Cross-reference against `gh-data.output.recently_closed_prs` to know whether they merged or were closed without merging. Same for issues.
- **Carry-over revisited**: each item in `prior_state.carry_over` — is it still open? Did its status change? If resolved, mention briefly under "Resolved since last run" and DROP from the state JSON's `carry_over`. If still pending, keep with original `first_seen` date (so age is preserved).
- **What you shipped**: `gh-data.output.my_recent_commits` lists the maintainer's commits since the last run. Summarize meaningfully — group by area, highlight notable ones. Don't just list shas.
- **New since last run**: PRs in current `all_open_prs` whose numbers are NOT in `prior_state.observed_prs` are new this run. Same for issues.

### 2c. Read the direction doc and profile

The `direction` markdown defines what Archon IS / IS NOT. The `profile` markdown describes the maintainer's role, scope, and current focus. Both inform the triage:

- **Profile scope** drives breadth of coverage. `scope: everything` (main maintainer) means classify all open PRs, not just ones touching the maintainer's focus areas.
- **Direction clauses** drive the polite-decline classification. PRs adding multi-tenancy, hosted-service features, or anything contradicting the IS-NOT list go to P4 with a citation.
- **Profile focus areas** weight prioritization within P1-P3 — items aligned with current focus rank higher.

### 2d. Triage all open PRs into P1-P4

For each PR in `all_open_prs`:

- **P1 (Do today)**: ready-to-merge PRs awaiting your review (`reviewDecision: APPROVED` or null AND `mergeStateStatus: clean`), security fixes, items breaking dev, blockers for an in-flight release. **Note**: `mergeStateStatus` is the only CI/merge signal in the gathered payload (values: `clean`, `unstable`, `dirty`, `blocked`, `behind`, `unknown`). For ambiguous cases run `gh pr checks <number>` to verify CI before classifying as P1.
- **P2 (This week)**: in-flight PRs needing review or maintainer feedback, PRs with merge conflicts that can be unblocked, PRs from the maintainer's current focus areas that are progressing.
- **P3 (Whenever)**: low-urgency items, drafts you authored, exploratory PRs, items outside current focus that aren't time-sensitive.
- **P4 (Polite-decline candidates)**: PRs that conflict with `direction.md`. Each P4 entry MUST cite a specific clause (e.g., `direction.md §single-developer-tool`).

You may use `gh pr view <number>`, `gh pr diff <number>`, or `gh pr checks <number>` to drill into PRs whose triage classification cannot be determined from the metadata alone. Be selective — drilling into all 60+ PRs is wasteful. Drill into 5-10 of the most ambiguous or interesting cases.

### 2e. Triage issues

Issues in `issues_assigned` and `recent_unlabeled_issues` follow the same P1-P4 classification. Use `gh issue view <number>` to drill into ambiguous ones. Recently-filed unlabeled issues are likely candidates for first-pass labeling.

### 2f. Surface direction questions

If any PR raises a "we don't have a stance on this" question that `direction.md` doesn't answer, surface it under **Direction questions raised**. These go into the state JSON's `direction_questions` so the maintainer can absorb them into `direction.md` over time.

### 2g. Carry-over aging

Items that have been in `prior_state.carry_over` for multiple runs (check `first_seen` dates) are higher priority — surface them prominently and consider escalating their P-level.

### 2h. Review-history awareness (cross-workflow memory)

`read-context.output.reviewed_prs` is a map of PR number → `{ reviewed_at, gate_verdict, run_id }` recording past maintainer-review-pr runs. When listing PRs in any P1-P4 (or Polite-decline) section, append a marker if the PR has an entry:

- **Reviewed (review branch)**: `✓ reviewed Nd ago` — N is days between `read-context.output.today` and `reviewed_at` (`YYYY-MM-DD` slice). Use `0d` for today, `1d` for yesterday, etc.
- **Declined (decline / needs_split branch)**: `✓ declined Nd ago` — same age math, distinct verb so the brief reads correctly when a PR was politely declined rather than reviewed.
- **Unclear**: `✓ triaged Nd ago (unclear)` — for `gate_verdict: 'unclear'` runs.

**Staleness check**: compare `reviewed_at` to the PR's `updatedAt` (in `gh-data.output.all_open_prs`). If `updatedAt > reviewed_at`, append `⚠ contributor pushed since` so the maintainer knows the prior review may need re-running. Only flag when the gap is real and meaningful — same-day commits don't need a warning.

PRs not in `reviewed_prs` get no marker (their absence is itself the signal: "not yet reviewed via the workflow").

---

## Phase 3: GENERATE OUTPUT

Output the brief as plain markdown FIRST, then a state JSON block at the end with EXACT delimiters. The persist node parses your output by splitting on those delimiters — do not return a JSON object wrapping the brief, and do not write any files yourself.

**No prose preamble.** Start the response with the `# Maintainer Standup` heading. **No content after the closing state marker.**

### Brief markdown (first)

A maintainer-ready markdown brief. Adapt sections — omit empty ones, add others if useful. Keep entries to one line each. The brief should be readable on a single screen.

```markdown
# Maintainer Standup — YYYY-MM-DD

## Since last run
- (Summary of new commits on dev with notable highlights, or "first run — baseline snapshot")
- (Mention pull_status if not 'pulled': dirty/not_on_dev/pull_failed)

## What you shipped
- (One-line summary grouped by area, derived from `my_recent_commits`. Omit if empty.)

## Resolved since last run
- **PR #N** — [title] — merged ✓ / closed
- **Issue #N** — [title] — closed
- (Omit section if nothing resolved.)

## Replies waiting on you
- **PR #N** — @author replied (N comments since last run): [one-line excerpt of latest comment]. [URL]
- **Issue #N** — @author commented: [excerpt]. [URL]
- (Sort by recency; surface inline-review-comment kinds first since they usually need a code-level response. Omit section if `replies_since_last_run` is empty.)

## P1 — Do today
- **PR #N** — [title] ([+X/-Y]) — [why P1, e.g. "ready to merge, awaiting your review"]
- **Issue #N** — [title] — [why P1]

## P2 — This week
- (Same format)

## P3 — Whenever
- (Same format)

## P4 — Polite-decline candidates
- **PR #N** — [title] by @[author] — Conflicts with `direction.md §[clause]`. [One-line reason.]

## Direction questions raised
- (PR #N raises: should Archon support [Y]? Add a stance to direction.md.)
- (Or omit if none.)

## Carry-over still pending
- **PR #N** — [title] — first seen YYYY-MM-DD ([N] runs ago) — [current status]
- (Omit section if nothing carried over.)
```

### State JSON block (LAST)

Immediately after the brief, emit a state JSON block with these EXACT delimiter lines (each on its own line, no surrounding code fences, no leading/trailing whitespace, no markdown formatting around them):

```
ARCHON_STATE_JSON_BEGIN
{
  "last_run_at": "<ISO-8601 timestamp>",
  "last_dev_sha": "<git-status.output.current_dev_sha>",
  "carry_over": [
    { "kind": "pr|issue|task|direction_question", "id": "<PR/issue number as string>", "note": "<why carried>", "first_seen": "<YYYY-MM-DD>" }
  ],
  "observed_prs": [
    { "number": <num>, "title": "<title>" }
  ],
  "observed_issues": [
    { "number": <num>, "title": "<title>" }
  ],
  "direction_questions": ["<surfaced question>"]
}
ARCHON_STATE_JSON_END
```

State schema rules:

- `last_run_at`: current ISO-8601 timestamp (use the actual timestamp at synthesis time).
- `last_dev_sha`: value from `git-status.output.current_dev_sha`.
- `carry_over`: items the next run should remember as "still pending." For items already in `prior_state.carry_over` that are still pending, **preserve the original `first_seen` date** so age is tracked correctly.
- `observed_prs`: snapshot of ALL currently-open PRs (number + title only) — used to detect new PRs and resolved PRs next run. This must include every entry in `all_open_prs`, not just ones you classified.
- `observed_issues`: same for assigned + unlabeled issues.
- `direction_questions`: new direction questions surfaced this run (string array).

The block must be valid JSON between the markers. Use empty arrays `[]` for sections with no entries — do not omit fields.

### PHASE_3_CHECKPOINT

- [ ] Response starts with the `# Maintainer Standup` heading (no prose preamble).
- [ ] State block uses the exact `ARCHON_STATE_JSON_BEGIN` / `ARCHON_STATE_JSON_END` markers, each on its own line.
- [ ] State block is valid JSON between the markers (no trailing commas, all required fields present).
- [ ] Nothing follows the closing marker.
- [ ] Every PR in `all_open_prs` is either classified into P1-P4 OR included in `observed_prs` (no PR silently dropped).
- [ ] All P4 entries cite a specific `direction.md §clause`.
- [ ] Carry-over items still pending have their original `first_seen` preserved.
- [ ] Resolved-since-last-run items are surfaced in the brief AND removed from `state.carry_over`.
- [ ] `state.last_dev_sha` is set from `git-status.output.current_dev_sha`.
- [ ] `state.observed_prs` includes ALL currently-open PRs.

---

## Phase 4: REPORT

Output the brief markdown then the delimited state block — nothing else. The persist node writes the brief markdown (everything before `ARCHON_STATE_JSON_BEGIN`) to `.archon/maintainer-standup/briefs/<date>.md` and the state JSON (between the markers) to `.archon/maintainer-standup/state.json`. Do not write files yourself.
