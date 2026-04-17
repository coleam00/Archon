# Slack @archie: feature request → review app

**Status:** Design approved, ready for implementation plan
**Date:** 2026-04-17
**Workflow name:** `archon-slack-feature-to-review-app`

## Problem

When a teammate has a feature idea, the path from "I wish we had X" to "there's a
working review app I can try" takes days and crosses many tools (spec doc, Jira
ticket, branch, PR, review, CI, deploy). Most of those steps are mechanical.

We want a single Slack interaction — `@archie, build a feature to do X` — to drive
the entire loop: clarify the idea, write a spec, get approval, implement in an
isolated worktree, open a PR, run code review until clean, wait for CI, deploy a
review app, and post the review-app URL back to the thread.

Primary target repo: **instrumentl/instrumentl**. Designed so a second project can
opt in later by registering its codebase with Archon and setting two config
values; no code changes required per new project.

## Non-Goals

- Replacing structured product discovery for large initiatives. This is for
  features small enough that a PRD-style spec is overkill — one Slack ask, one PR.
- Bug fixes (use `archon-fix-github-issue`).
- Spec-only / PRD-only workflows (use `archon-interactive-prd`).
- Merging the PR. The final artifact is a review app + a PR ready for human
  review and merge.

## Success Criteria

- A user in Slack tags `@archie` with a feature request and, without leaving the
  thread, is asked 3 clarifying question rounds, receives a spec to approve,
  then receives ongoing progress updates and a final review-app URL.
- Works end-to-end against `instrumentl/instrumentl` with no custom code beyond
  the workflow YAML and 3 helper scripts.
- Re-targeting at a second project requires only: registering the codebase in
  Archon, setting `reviewApp.workflowFile` and `reviewApp.urlCommentPattern` in
  that repo's `.archon/config.yaml`.

## Approach Summary

One new bundled workflow in `packages/workflows/src/defaults/workflows/` that
composes existing commands (spec questions from `archon-interactive-prd`, plan +
implement + PR + review agents from `archon-idea-to-pr`) and adds three small
new pieces:

1. A bounded 3-iteration spec revision loop.
2. A bounded 2-round code-review loop with an exit condition on "no blocking
   findings".
3. Three new bash/script helpers: wait for CI, dispatch the review-app GitHub
   Actions workflow, poll PR comments for the review-app URL.

Plus ~7 lightweight `prompt:` announce nodes at phase boundaries that stream
status lines to the Slack thread.

## Trigger + Routing

No custom Slack adapter work. The flow uses existing infrastructure:

- `SlackAdapter.start()` fires on `app_mention` — strips the mention, passes
  text to the orchestrator.
- The orchestrator's router (`archon-assist`) matches workflow `description`
  fields. This workflow's description matches phrases like `build X`, `add
  feature Y`, `implement Z`, `ship a feature that...`.
- Conversation ID = `channel:thread_ts` — every message and gate response stays
  in the same thread.
- The worktree branch is auto-generated from the feature slug, e.g.,
  `archie/csv-grant-export-2026-04-17`.

## Configuration

New optional `reviewApp` section in `.archon/config.yaml` (per-project):

```yaml
reviewApp:
  workflowFile: deploy-to-review-app.yml
  urlCommentPattern: 'https://[^\s)]+\.review\.instrumentl\.com[^\s)]*'
```

Defaults target Instrumentl. Missing values fall back to sensible defaults;
`urlCommentPattern` not matching any comment after the polling window fails
loudly with a clear error rather than silently succeeding.

## Workflow Node Graph

File: `packages/workflows/src/defaults/workflows/archon-slack-feature-to-review-app.yaml`.

Header:

```yaml
name: archon-slack-feature-to-review-app
description: |
  Use when: A user on Slack/chat asks @archie to build, add, or implement a
  feature end-to-end and wants a working review app at the end. Matches phrases
  like "build X", "add feature Y", "implement Z", "ship a feature that...".
  Input: Feature description in natural language.
  Output: Merged-ready PR + review-app URL posted back to the requesting thread.
  NOT for: Spec/PRD only (use archon-interactive-prd), code-only changes without
  a spec (use archon-idea-to-pr), or bug fixes (use archon-fix-github-issue).
interactive: true
provider: claude
```

### Phases

**A. Spec creation (interactive, bounded 3-iteration revision loop)**
- Reuse foundation / deep-dive / scope question nodes from
  `archon-interactive-prd`, each gated by `approval: capture_response: true`.
- `spec-generate` writes to `$ARTIFACTS_DIR/specs/<slug>.spec.md`.
- `spec-approval-loop`: `loop:` node wrapping a revise prompt + an approval
  gate. Exit on approve. `$REJECTION_REASON` feeds revision. Max 3 iterations.
  On cap-hit: post "Spec revision limit reached..." and fail gracefully.

**B. Plan**
- `archon-create-plan` with the spec path.
- `archon-plan-setup` creates the worktree + branch.

**C. Implement + validate**
- `archon-implement-tasks` on `claude-opus-4-6[1m]`.
- `archon-validate` runs `bun run validate`.

**D. PR creation**
- `archon-finalize-pr` opens the PR and marks it ready. PR URL/number flows
  forward via `$finalize-pr.output`.

**E. Code review loop (bounded 2 rounds)**
Single `loop:` node, exit condition "no blocking findings" from
`archon-synthesize-review`, max 2 iterations. Body:
- `review-scope`, `sync`.
- Five parallel review agents: `archon-code-review-agent`,
  `archon-error-handling-agent`, `archon-test-coverage-agent`,
  `archon-comment-quality-agent`, `archon-docs-impact-agent`.
- `archon-synthesize-review`.
- `archon-implement-review-fixes`.
- On cap-hit with unresolved blocking findings: post findings to Slack and
  stop before Phase F. Don't deploy broken code.

**F. Wait for CI**
- `ci-wait`: `bash:` / `script:` node wrapping
  `gh pr checks <pr> --watch --fail-fast --interval 30`. 60-minute timeout
  (configurable).
- On red: one additional call to `archon-implement-review-fixes` with CI logs
  attached as context (separate node from Phase E; does NOT re-enter the review
  loop — this is a CI-failure-specific fix pass, not a code-review pass),
  followed by one retry of `ci-wait`. Still red → stop with logs posted to
  Slack.

**G. Trigger review app**
- `deploy-review-app`: `bash:` node — `gh workflow run ${reviewApp.workflowFile}
  --ref <pr-branch>`.

**H. Fetch review-app URL**
- `fetch-review-url`: `bash:` / `script:` node polling
  `gh pr view <pr> --json comments` every 20s for up to 15 min, grepping for
  `reviewApp.urlCommentPattern`. Extracts the first match. Fails loudly with a
  clear message if not found in window.

**I. Final post to Slack**
- `announce-done`: `prompt:` node emits the final message with PR URL,
  review-app URL, review-loop iterations used, total time. Because the
  workflow is `interactive: true`, output streams to the Slack thread.

### Progress Announcements (Option A — inline)

Short `prompt:` announce nodes at phase boundaries, each directed to print
exactly one status line. Uses `haiku` / cheapest model available. Streams to
Slack via the `interactive: true` mechanism.

Fixed announces (always fire on happy path): 6 — after spec approval, after
plan, after implementation+validation, after PR creation, after review passes,
after CI passes. The final "done" message is `announce-done` in Phase I.

Additional announces inside loops (fire variably): review-round-start,
fixes-applied, re-reviewing, CI-failed-retrying. Expect 6–10 total on the
happy path depending on how many review/CI loop iterations run.

Example sequence:

```
🧠 Spec approved. Creating implementation plan...
🏗️  Plan ready. Spinning up worktree <branch> and implementing...
✅ Implementation passed local validation. Opening PR...
🔍 PR #<n> opened. Running code review (round 1 of 2)...
🔧 Review found <k> blocking issues. Applying fixes...
🔍 Re-reviewing...
✅ Review clean. Waiting on CI...
🚀 CI green. Deploying review app...
🎉 Done. PR: <url>   Review app: <url>
```

Intermediate announces between review rounds are emitted inside the loop body;
the sequence shown is the happy-path flow.

### Dependency Graph

Strictly linear A → B → C → D → E → F → G → H → I. Parallelism lives inside
phase E's review-loop body only.

## Authorization

- `SLACK_ALLOWED_USER_IDS` (existing) gates who can talk to the bot at all.
- Any authorized user in the thread can approve/reject/provide feedback at
  any gate. Matches team norms; no second-layer approver list.

## Failure Modes

Each case posts a single explanatory message to the thread.

**Spec phase**
- User abandons mid-questionnaire → 24h approval-gate timeout → "No response in
  24h — cancelling. Tag @archie again when ready."
- Spec revision cap hit → "Spec revision limit reached. Your last feedback:
  <truncated>. Please re-tag @archie with a tighter description."

**Plan / implement / validate**
- Plan step errors → existing error propagation posts to thread.
- Validation still red after internal retries → "Implementation didn't pass
  local validation. Last error: <head of stderr>. PR not created."
- Worktree issues → existing `classifyIsolationError` mapping.

**PR / review**
- `gh pr create` errors → raw `gh` error posted.
- Review loop cap hit with unresolved blockers → "Code review didn't converge
  after 2 rounds. PR open at <url>. Remaining blocking findings: ..."

**CI**
- CI goes red → one fix retry, then "CI still failing after 1 fix attempt.
  PR: <url>. Latest CI logs: ..."
- CI timeout (60 min) → "CI hasn't completed in 60 min. PR: <url>."

**Review app**
- `gh workflow run` dispatch fails → "Couldn't trigger <workflowFile> — <gh
  error>. PR is ready at <url>; deploy manually."
- URL not found in 15-min window → "Review app dispatched but no matching URL
  appeared in PR comments. Pattern: <regex>. PR: <url>."

**Cross-cutting**
- `/workflow abandon` → standard engine behavior.
- Archon server restart → `/workflow resume <id>` works; interactive workflow
  resumes from last completed node.
- Slack thread archived mid-run → platform `sendMessage` errors logged, run
  completes in DB; user sees results in Archon web UI.

## Testing

**Static validation**
- `bun run cli validate workflows archon-slack-feature-to-review-app` — YAML
  schema, command refs, `depends_on` edges, `$nodeId.output` refs.
- Added to `bundled-defaults.test.ts`'s "all bundled workflows parse" assertion.

**Unit tests (new scripts in `.archon/scripts/`)**
- `ci-wait.ts` — mocked `execFileAsync` for green / red / timeout cases.
- `fetch-review-app-url.ts` — first-poll match, eventual-poll match, no-match
  timeout, invalid JSON.
- `dispatch-review-app.ts` — invoked with expected args.

**Integration test (one)**
Run the workflow through the executor with:
- `MockAgentProvider` returning canned AI responses.
- `execFileAsync` mocked for all `gh` calls.
- In-memory platform adapter capturing `sendMessage`.

Assert: the expected happy-path announce messages land in order on the
captured platform, workflow reaches `done`, final message contains both PR URL
and review-app URL. Exact count asserted is the fixed happy-path set (6 +
final = 7); variable review/CI announces are not count-asserted to keep the
test non-brittle.

**Manual validation checklist (first real run)**
1. Tag `@archie` with a trivial feature request.
2. Verify 3 question gates ask, answers feed spec.
3. Verify approve path; trigger reject-with-feedback once to confirm revision
   loop.
4. Verify PR created with correct branch name.
5. Verify review loop runs; synthesize output sane.
6. Verify `gh workflow run deploy-to-review-app.yml` fires after CI.
7. Verify review-app URL parsed from PR comment and posted to thread.

**Explicitly NOT testing:** Slack adapter (already covered), the 5 review
agents (already covered), `gh` CLI behavior.

## Implementation Artifacts

New files:
- `packages/workflows/src/defaults/workflows/archon-slack-feature-to-review-app.yaml`
- `.archon/scripts/ci-wait.ts`
- `.archon/scripts/fetch-review-app-url.ts`
- `.archon/scripts/dispatch-review-app.ts`
- Corresponding `*.test.ts` next to each script.

Modified files:
- `packages/workflows/src/defaults/bundled-defaults.ts` — register the new
  workflow YAML import.
- `packages/workflows/src/defaults/bundled-defaults.test.ts` — ensure the new
  workflow parses.

No changes to:
- `packages/adapters/src/chat/slack/` — Slack adapter as-is.
- `packages/core/src/orchestrator/` — routing as-is.
- Database schema.

## Open Decisions for the Implementation Plan

- Exact `.archon/config.yaml` schema location for `reviewApp` (top-level key
  vs. nested under `codebase`). Leaning top-level `reviewApp:`.
- Whether announce nodes should use `sonnet` or `haiku` — leaning cheapest
  option that reliably emits exact text, TBD during implementation.
- Naming: `announce-*` node prefix vs. emoji-first in-node IDs. Cosmetic; pick
  during implementation.

## Follow-Up Work (Not in This Design)

- Option B for progress (workflow-event-driven Slack updates) — revisit if more
  workflows need identical announce patterns.
- Auto-merge of the PR once review-app is validated by a human "ship it" reply
  — separate workflow.
- Support for non-GitHub review-app deploy mechanisms (e.g., direct HTTP
  webhook) — only if a second project needs it.
