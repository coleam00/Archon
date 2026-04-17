# @archie Slack feature-to-review-app Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one bundled Archon workflow (`archon-slack-feature-to-review-app`) that takes a natural-language feature request in Slack and drives it end-to-end to a PR + deployed review app, with progress posted to the thread.

**Architecture:** One new YAML workflow composing existing commands (spec questions from `archon-interactive-prd`, plan/implement/PR/review agents from `archon-idea-to-pr`) plus three small `.archon/scripts/` helpers (dispatch a GH Actions workflow, wait for CI, poll PR comments for the review-app URL). No adapter or orchestrator changes. Registered as a bundled default so it's available in binary builds.

**Tech Stack:** Bun + TypeScript, Archon workflow engine (DAG + loop nodes), `gh` CLI for GitHub interactions, existing Slack adapter (no changes).

**Related design doc:** `docs/specs/2026-04-17-slack-archie-feature-to-review-app-design.md`.

---

## File Structure

New files:
- `.archon/scripts/dispatch-review-app.ts` — shell-safe wrapper around `gh workflow run`.
- `.archon/scripts/ci-wait.ts` — polls `gh pr checks --watch` with a hard timeout; exits 0 on green, non-zero on red/timeout.
- `.archon/scripts/fetch-review-app-url.ts` — polls `gh pr view --json comments` every 20s up to 15 min, regex-extracts the first URL match.
- `.archon/workflows/defaults/archon-slack-feature-to-review-app.yaml` — the workflow.

Modified files:
- `packages/workflows/src/defaults/bundled-defaults.ts` — register the new workflow YAML.
- `packages/workflows/src/defaults/bundled-defaults.test.ts` — extend existing parse assertion to cover it (only if a count assertion exists).

No changes to: Slack adapter, orchestrator, DB schema, Zod config schemas.

---

### Task 1: Script — dispatch-review-app.ts

**Files:**
- Create: `.archon/scripts/dispatch-review-app.ts`

Small shell wrapper. The workflow passes two CLI args: `<workflow-file>` (e.g. `deploy-to-review-app.yml`) and `<ref>` (the PR branch). Exits 0 on dispatch success, non-zero with a clear message otherwise.

- [ ] **Step 1: Write the script**

Create `.archon/scripts/dispatch-review-app.ts` with the following contents:

```typescript
#!/usr/bin/env bun
/**
 * Dispatch a GitHub Actions workflow_dispatch event on the given ref.
 *
 * Usage: bun .archon/scripts/dispatch-review-app.ts <workflow-file> <ref>
 *
 * Exits 0 on successful dispatch. Exits non-zero with a human-readable stderr
 * message on any failure (missing args, gh not installed, gh call failed).
 *
 * Used by the archon-slack-feature-to-review-app workflow after CI passes
 * to deploy a review app for the PR branch.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const [workflowFile, ref] = process.argv.slice(2);

  if (!workflowFile || !ref) {
    console.error('Usage: dispatch-review-app.ts <workflow-file> <ref>');
    process.exit(2);
  }

  try {
    const { stdout, stderr } = await execFileAsync('gh', [
      'workflow',
      'run',
      workflowFile,
      '--ref',
      ref,
    ]);
    if (stdout.trim()) console.log(stdout.trim());
    if (stderr.trim()) console.log(stderr.trim());
    console.log(
      JSON.stringify({ dispatched: true, workflow: workflowFile, ref })
    );
  } catch (err) {
    const e = err as Error & { stderr?: string };
    console.error(
      `Failed to dispatch ${workflowFile} on ref ${ref}: ${e.stderr ?? e.message}`
    );
    process.exit(1);
  }
}

void main();
```

- [ ] **Step 2: Verify it runs with a missing-arg check**

Run: `bun .archon/scripts/dispatch-review-app.ts; echo "exit=$?"`

Expected: usage line on stderr, line `exit=2` on stdout.

- [ ] **Step 3: Commit**

```bash
git add .archon/scripts/dispatch-review-app.ts
git commit -m "feat(scripts): dispatch-review-app helper for slack feature workflow

Wraps gh workflow run for review-app deployment; exits non-zero with a
clear message on dispatch failure. Used by archon-slack-feature-to-review-app."
```

---

### Task 2: Script — ci-wait.ts

**Files:**
- Create: `.archon/scripts/ci-wait.ts`

Polls `gh pr checks <pr> --watch --fail-fast` with an outer wall-clock timeout. `gh pr checks --watch` already exits 0 on all-green and 1 on any failure; we add a parent process timeout so we never hang.

- [ ] **Step 1: Write the script**

Create `.archon/scripts/ci-wait.ts` with the following contents:

```typescript
#!/usr/bin/env bun
/**
 * Wait for GitHub CI on a PR to finish, with a hard wall-clock timeout.
 *
 * Usage: bun .archon/scripts/ci-wait.ts <pr-number-or-url> [timeout-ms]
 *
 * Exit codes:
 *   0 — all required checks passed
 *   1 — at least one required check failed
 *   3 — timeout reached before CI finished
 *   2 — bad args / missing gh
 *
 * Used by archon-slack-feature-to-review-app to gate review-app deploy.
 */
import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

function main(): void {
  const [pr, timeoutArg] = process.argv.slice(2);

  if (!pr) {
    console.error('Usage: ci-wait.ts <pr-number-or-url> [timeout-ms]');
    process.exit(2);
  }

  const timeoutMs = timeoutArg ? Number(timeoutArg) : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    console.error(`Invalid timeout-ms: ${timeoutArg}`);
    process.exit(2);
  }

  console.log(
    `Waiting for CI on PR ${pr} (timeout: ${Math.round(timeoutMs / 1000)}s)...`
  );

  const child = spawn(
    'gh',
    ['pr', 'checks', pr, '--watch', '--fail-fast', '--interval', '30'],
    { stdio: 'inherit' }
  );

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    console.error(`\nCI wait timed out after ${Math.round(timeoutMs / 1000)}s`);
    child.kill('SIGTERM');
    setTimeout(() => process.exit(3), 2000).unref();
  }, timeoutMs);
  timer.unref();

  child.on('exit', (code, _signal) => {
    clearTimeout(timer);
    if (timedOut) return;
    if (code === 0) {
      console.log('CI passed.');
      process.exit(0);
    }
    console.error(`CI failed (gh exit code ${code ?? 'null'})`);
    process.exit(1);
  });

  child.on('error', err => {
    clearTimeout(timer);
    console.error(`Failed to spawn gh: ${err.message}`);
    process.exit(2);
  });
}

main();
```

- [ ] **Step 2: Verify arg validation**

Run: `bun .archon/scripts/ci-wait.ts; echo "exit=$?"`

Expected: usage line on stderr, `exit=2`.

Run: `bun .archon/scripts/ci-wait.ts 99999 abc; echo "exit=$?"`

Expected: `Invalid timeout-ms: abc` on stderr, `exit=2`.

- [ ] **Step 3: Commit**

```bash
git add .archon/scripts/ci-wait.ts
git commit -m "feat(scripts): ci-wait helper with hard timeout

Wraps gh pr checks --watch --fail-fast with a wall-clock timeout so the
workflow can't hang indefinitely. Exit codes distinguish pass/fail/timeout."
```

---

### Task 3: Script — fetch-review-app-url.ts

**Files:**
- Create: `.archon/scripts/fetch-review-app-url.ts`

Polls the PR's comments via `gh pr view --json comments` every 20 seconds for up to 15 minutes, looking for a URL matching a caller-supplied regex. Prints the URL on stdout and exits 0 on match; non-zero on timeout. Log lines go to stderr so `$nodeId.output` captures only the URL.

- [ ] **Step 1: Write the script**

Create `.archon/scripts/fetch-review-app-url.ts` with the following contents:

```typescript
#!/usr/bin/env bun
/**
 * Poll a GitHub PR's comments for a review-app URL matching a regex.
 *
 * Usage:
 *   bun .archon/scripts/fetch-review-app-url.ts <pr> <regex> [timeout-ms] [interval-ms]
 *
 * Exit codes:
 *   0 — URL found; printed to stdout as the only stdout line
 *   3 — timeout reached without a match
 *   2 — bad args / gh failure / invalid regex / bad comments JSON
 *
 * The workflow consumes the trimmed stdout via $<node-id>.output.
 * All log lines go to stderr so the URL is the only stdout content.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 20 * 1000;

interface CommentShape {
  body?: string;
}

async function pollOnce(
  pr: string,
  regex: RegExp
): Promise<string | null> {
  const { stdout } = await execFileAsync('gh', [
    'pr',
    'view',
    pr,
    '--json',
    'comments',
  ]);
  let parsed: { comments?: CommentShape[] };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`gh returned non-JSON stdout: ${stdout.slice(0, 200)}`);
  }
  const comments = parsed.comments ?? [];
  for (const c of comments) {
    const match = typeof c.body === 'string' ? c.body.match(regex) : null;
    if (match) return match[0];
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const [pr, regexStr, timeoutArg, intervalArg] = process.argv.slice(2);

  if (!pr || !regexStr) {
    console.error(
      'Usage: fetch-review-app-url.ts <pr> <regex> [timeout-ms] [interval-ms]'
    );
    process.exit(2);
  }

  let regex: RegExp;
  try {
    regex = new RegExp(regexStr);
  } catch (err) {
    console.error(
      `Invalid regex ${JSON.stringify(regexStr)}: ${(err as Error).message}`
    );
    process.exit(2);
  }

  const timeoutMs = timeoutArg ? Number(timeoutArg) : DEFAULT_TIMEOUT_MS;
  const intervalMs = intervalArg ? Number(intervalArg) : DEFAULT_INTERVAL_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    console.error(`Invalid timeout-ms: ${timeoutArg}`);
    process.exit(2);
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    console.error(`Invalid interval-ms: ${intervalArg}`);
    process.exit(2);
  }

  const deadline = Date.now() + timeoutMs;
  console.error(
    `Polling PR ${pr} for pattern ${regex} every ${Math.round(intervalMs / 1000)}s, up to ${Math.round(timeoutMs / 1000)}s total...`
  );

  while (Date.now() < deadline) {
    try {
      const match = await pollOnce(pr, regex);
      if (match) {
        console.log(match);
        return;
      }
    } catch (err) {
      console.error(`Poll error (will retry): ${(err as Error).message}`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }

  console.error(
    `No matching comment found on PR ${pr} within ${Math.round(timeoutMs / 1000)}s.`
  );
  process.exit(3);
}

void main();
```

- [ ] **Step 2: Verify arg validation**

Run: `bun .archon/scripts/fetch-review-app-url.ts; echo "exit=$?"`

Expected: usage line on stderr, `exit=2`.

Run: `bun .archon/scripts/fetch-review-app-url.ts 1 '[' 5000; echo "exit=$?"`

Expected: `Invalid regex "["...` on stderr, `exit=2`.

- [ ] **Step 3: Commit**

```bash
git add .archon/scripts/fetch-review-app-url.ts
git commit -m "feat(scripts): fetch-review-app-url helper

Polls gh pr view --json comments for a URL matching a caller-supplied
regex; prints the URL on stdout, errors on stderr so the workflow engine
captures only the URL via \$nodeId.output."
```

---

### Task 4: Workflow YAML — archon-slack-feature-to-review-app

**Files:**
- Create: `.archon/workflows/defaults/archon-slack-feature-to-review-app.yaml`

The main artifact. Implementation decisions:
- Spec revision is a `loop:` node with `interactive: true` matching `archon-piv-loop`'s `refine-plan` pattern. Signal: `<promise>SPEC_APPROVED</promise>`, `max_iterations: 3`.
- Code review "2 rounds max" is **explicitly unrolled** (not a `loop:` node) because loops are single-prompt-bodied and our review needs a 5-parallel-agents sub-graph. Round 2 uses `when:` to skip itself when round 1 was clean.
- Scripts are invoked via `bash:` wrappers (not `script:` nodes) because `script:` nodes do not accept CLI args.
- Instrumentl-specific review-app parameters (`deploy-to-review-app.yml`, `*.review.instrumentl.com` regex) are hardcoded as literal strings. Per-project overrides are future work.

- [ ] **Step 1: Write the workflow YAML**

Create `.archon/workflows/defaults/archon-slack-feature-to-review-app.yaml` with:

```yaml
name: archon-slack-feature-to-review-app
description: |
  Use when: User on Slack/chat asks @archie to build, add, or implement a
  feature end-to-end and wants a working review app at the end. Matches
  phrases like "build X", "add feature Y", "implement Z", "ship a feature
  that...".
  Input: Feature description in natural language.
  Output: PR ready for review + review-app URL posted back to the thread.
  NOT for: Spec/PRD only (use archon-interactive-prd), code-only changes
  without a spec (use archon-idea-to-pr), or bug fixes
  (use archon-fix-github-issue).

provider: claude
interactive: true

nodes:
  # ═══════════════════════════════════════════════════════════════
  # PHASE A — SPEC CREATION (bounded 3-iteration revision loop)
  # ═══════════════════════════════════════════════════════════════

  - id: spec
    model: sonnet
    loop:
      prompt: |
        # Feature request → spec

        You are turning a Slack-submitted feature request into a focused
        implementation spec, through iterative dialogue.

        **Original request**: $ARGUMENTS
        **User's latest reply**: $LOOP_USER_INPUT

        ---

        ## If this is the first iteration ($LOOP_USER_INPUT is empty):

        1. Restate your understanding of the request in 1-2 sentences.
        2. Explore the codebase briefly (CLAUDE.md, directory structure,
           files obviously related to the feature).
        3. Ask a tight set of 3-5 clarifying questions focused on DECISIONS
           (scope boundaries, which existing code to extend, test
           expectations, explicit out-of-scope items).
        4. End with: "Answer the questions and I'll draft a spec."
        5. Do NOT emit the approval signal yet.

        ## If the user has replied:

        1. Process their answers.
        2. If you now have enough to draft a spec, write it to
           `.claude/archon/specs/<kebab-slug>.spec.md` with these sections:
           - Problem
           - Proposed change (which files, functions, interfaces)
           - Out of scope
           - Acceptance criteria (specific, testable bullets)
           - Testing plan
        3. Present a condensed summary of the spec in-thread (not the full
           file), end with: "Reply `approved` to implement, or tell me what
           to change."
        4. If the user's latest reply EXPLICITLY approves (contains
           "approved", "looks good", "ship it", "go"), emit
           <promise>SPEC_APPROVED</promise> and stop. Otherwise, revise the
           spec file based on their feedback and re-summarize.

        **CRITICAL**: Never emit <promise>SPEC_APPROVED</promise> unless the
        user's LATEST message explicitly approves. Questions, feedback, and
        change requests are NOT approval.
      until: SPEC_APPROVED
      max_iterations: 3
      interactive: true
      gate_message: |
        Answer the questions above, or reply "approved" once the spec looks right.

  - id: announce-spec-approved
    depends_on: [spec]
    bash: 'echo "🧠 Spec approved. Creating implementation plan..."'

  # ═══════════════════════════════════════════════════════════════
  # PHASE B — PLAN
  # ═══════════════════════════════════════════════════════════════

  - id: create-plan
    command: archon-create-plan
    depends_on: [announce-spec-approved]
    context: fresh

  - id: plan-setup
    command: archon-plan-setup
    depends_on: [create-plan]
    context: fresh

  - id: announce-plan-ready
    depends_on: [plan-setup]
    bash: 'echo "🏗️  Plan ready. Implementing in a fresh worktree..."'

  # ═══════════════════════════════════════════════════════════════
  # PHASE C — IMPLEMENT + VALIDATE
  # ═══════════════════════════════════════════════════════════════

  - id: implement-tasks
    command: archon-implement-tasks
    depends_on: [announce-plan-ready]
    context: fresh
    model: claude-opus-4-6[1m]

  - id: validate
    command: archon-validate
    depends_on: [implement-tasks]
    context: fresh

  - id: announce-validated
    depends_on: [validate]
    bash: 'echo "✅ Implementation passed local validation. Opening PR..."'

  # ═══════════════════════════════════════════════════════════════
  # PHASE D — PR
  # ═══════════════════════════════════════════════════════════════

  - id: finalize-pr
    command: archon-finalize-pr
    depends_on: [announce-validated]
    context: fresh

  - id: announce-pr-open
    depends_on: [finalize-pr]
    bash: 'echo "🔍 PR opened. Running code review (round 1 of 2)..."'

  # ═══════════════════════════════════════════════════════════════
  # PHASE E — CODE REVIEW: ROUND 1
  # (five parallel agents → synthesize → conditional fix)
  # ═══════════════════════════════════════════════════════════════

  - id: review-scope-1
    command: archon-pr-review-scope
    depends_on: [announce-pr-open]
    context: fresh

  - id: sync-1
    command: archon-sync-pr-with-main
    depends_on: [review-scope-1]
    context: fresh

  - id: code-review-1
    command: archon-code-review-agent
    depends_on: [sync-1]
    context: fresh

  - id: error-handling-1
    command: archon-error-handling-agent
    depends_on: [sync-1]
    context: fresh

  - id: test-coverage-1
    command: archon-test-coverage-agent
    depends_on: [sync-1]
    context: fresh

  - id: comment-quality-1
    command: archon-comment-quality-agent
    depends_on: [sync-1]
    context: fresh

  - id: docs-impact-1
    command: archon-docs-impact-agent
    depends_on: [sync-1]
    context: fresh

  - id: synthesize-1
    command: archon-synthesize-review
    depends_on:
      - code-review-1
      - error-handling-1
      - test-coverage-1
      - comment-quality-1
      - docs-impact-1
    trigger_rule: none_failed_min_one_success
    context: fresh
    output_format:
      type: object
      properties:
        blocking_findings_count:
          type: number
        summary:
          type: string
      required: [blocking_findings_count]

  - id: announce-round-1-result
    depends_on: [synthesize-1]
    bash: |
      count="$synthesize-1.output.blocking_findings_count"
      if [ "$count" = "0" ]; then
        echo "✅ Review round 1 clean. Waiting on CI..."
      else
        echo "🔧 Review round 1 found $count blocking issue(s). Applying fixes..."
      fi

  - id: implement-fixes-1
    command: archon-implement-review-fixes
    depends_on: [announce-round-1-result]
    context: fresh
    when: '$synthesize-1.output.blocking_findings_count > 0'

  # ═══════════════════════════════════════════════════════════════
  # PHASE E — CODE REVIEW: ROUND 2 (only if round 1 had findings)
  # ═══════════════════════════════════════════════════════════════

  - id: announce-round-2-start
    depends_on: [implement-fixes-1]
    bash: 'echo "🔍 Re-reviewing after fixes..."'
    when: '$synthesize-1.output.blocking_findings_count > 0'

  - id: review-scope-2
    command: archon-pr-review-scope
    depends_on: [announce-round-2-start]
    context: fresh
    when: '$synthesize-1.output.blocking_findings_count > 0'

  - id: code-review-2
    command: archon-code-review-agent
    depends_on: [review-scope-2]
    context: fresh

  - id: error-handling-2
    command: archon-error-handling-agent
    depends_on: [review-scope-2]
    context: fresh

  - id: test-coverage-2
    command: archon-test-coverage-agent
    depends_on: [review-scope-2]
    context: fresh

  - id: comment-quality-2
    command: archon-comment-quality-agent
    depends_on: [review-scope-2]
    context: fresh

  - id: docs-impact-2
    command: archon-docs-impact-agent
    depends_on: [review-scope-2]
    context: fresh

  - id: synthesize-2
    command: archon-synthesize-review
    depends_on:
      - code-review-2
      - error-handling-2
      - test-coverage-2
      - comment-quality-2
      - docs-impact-2
    trigger_rule: none_failed_min_one_success
    context: fresh
    output_format:
      type: object
      properties:
        blocking_findings_count:
          type: number
        summary:
          type: string
      required: [blocking_findings_count]

  - id: review-gate
    depends_on: [synthesize-1, synthesize-2]
    trigger_rule: none_failed_min_one_success
    bash: |
      r1="$synthesize-1.output.blocking_findings_count"
      r2="$synthesize-2.output.blocking_findings_count"
      if [ "$r1" = "0" ]; then
        echo "✅ Review clean (round 1). Waiting on CI..."
        exit 0
      fi
      if [ -n "$r2" ] && [ "$r2" = "0" ]; then
        echo "✅ Review clean (round 2). Waiting on CI..."
        exit 0
      fi
      echo "⛔ Code review did not converge after 2 rounds."
      echo "Round 1 summary: $synthesize-1.output.summary"
      echo "Round 2 summary: $synthesize-2.output.summary"
      echo "PR is open; stopping before CI and review-app deploy."
      exit 1

  # ═══════════════════════════════════════════════════════════════
  # PHASE F — WAIT FOR CI
  # ═══════════════════════════════════════════════════════════════

  - id: extract-pr-number
    depends_on: [review-gate]
    bash: |
      set -e
      number=$(gh pr view --json number --jq '.number')
      if [ -z "$number" ] || [ "$number" = "null" ]; then
        echo "ERROR: could not resolve PR number for current branch" >&2
        exit 1
      fi
      printf '%s\n' "$number"

  - id: ci-wait
    depends_on: [extract-pr-number]
    timeout: 3900000
    bash: |
      set -e
      bun .archon/scripts/ci-wait.ts "$extract-pr-number.output" 3600000

  - id: announce-ci-pass
    depends_on: [ci-wait]
    bash: 'echo "🚀 CI green. Deploying review app..."'

  # ═══════════════════════════════════════════════════════════════
  # PHASE G — DISPATCH REVIEW-APP DEPLOY
  # ═══════════════════════════════════════════════════════════════

  - id: deploy-review-app
    depends_on: [announce-ci-pass]
    bash: |
      set -e
      branch=$(gh pr view --json headRefName --jq '.headRefName')
      bun .archon/scripts/dispatch-review-app.ts deploy-to-review-app.yml "$branch"

  # ═══════════════════════════════════════════════════════════════
  # PHASE H — FETCH REVIEW-APP URL FROM PR COMMENTS
  # ═══════════════════════════════════════════════════════════════

  - id: fetch-review-url
    depends_on: [deploy-review-app]
    timeout: 1000000
    bash: |
      set -e
      bun .archon/scripts/fetch-review-app-url.ts \
        "$extract-pr-number.output" \
        'https://[^[:space:])]+\.review\.instrumentl\.com[^[:space:])]*' \
        900000 20000

  # ═══════════════════════════════════════════════════════════════
  # PHASE I — FINAL POST
  # ═══════════════════════════════════════════════════════════════

  - id: announce-done
    depends_on: [fetch-review-url]
    model: haiku
    prompt: |
      Output ONLY the final status message below, with placeholders filled.
      No preamble, no code fences, no commentary.

      First, resolve the PR URL:
      `gh pr view --json url --jq .url`

      The review-app URL is: $fetch-review-url.output

      Message format:

      🎉 Done!
      • PR: <pr-url>
      • Review app: $fetch-review-url.output

      Open the review app to try it out; review the PR when you're ready to merge.
```

- [ ] **Step 2: Validate the workflow parses**

Run:

```bash
bun run cli validate workflows archon-slack-feature-to-review-app
```

Expected: no errors. All referenced commands (`archon-create-plan`, `archon-plan-setup`, `archon-implement-tasks`, `archon-validate`, `archon-finalize-pr`, `archon-pr-review-scope`, `archon-sync-pr-with-main`, `archon-code-review-agent`, `archon-error-handling-agent`, `archon-test-coverage-agent`, `archon-comment-quality-agent`, `archon-docs-impact-agent`, `archon-synthesize-review`, `archon-implement-review-fixes`) must exist. All referenced scripts (`ci-wait`, `dispatch-review-app`, `fetch-review-app-url`) must exist in `.archon/scripts/`.

If the validator complains about a missing command, verify it exists under `.archon/commands/defaults/` or in the validator's discovery path. If missing, the design assumed it existed — reopen the design doc and adjust.

If the validator complains about `when:` expression syntax or `output_format` keys, fix according to the error message.

- [ ] **Step 3: Commit**

```bash
git add .archon/workflows/defaults/archon-slack-feature-to-review-app.yaml
git commit -m "feat(workflows): archon-slack-feature-to-review-app

End-to-end workflow for Slack @archie feature requests: interactive spec
creation (bounded 3-iteration revision loop), plan + implement + PR using
existing commands, two-round code review with conditional second pass, CI
wait, review-app dispatch, URL fetch from PR comments, and final post back
to the Slack thread. Composes existing commands; adds no new adapter or
orchestrator code."
```

---

### Task 5: Register the workflow in bundled defaults

**Files:**
- Modify: `packages/workflows/src/defaults/bundled-defaults.ts`
- Modify: `packages/workflows/src/defaults/bundled-defaults.test.ts` (only if a count assertion exists)

Binary builds read bundled workflows from a compile-time text import map. Add the new workflow to both the import list and the exported map.

- [ ] **Step 1: Add the import**

Open `packages/workflows/src/defaults/bundled-defaults.ts`. In the workflow imports section, after the line importing `archonWorkflowBuilderWf`, add:

```typescript
import archonSlackFeatureToReviewAppWf from '../../../../.archon/workflows/defaults/archon-slack-feature-to-review-app.yaml' with { type: 'text' };
```

- [ ] **Step 2: Add the map entry**

In the same file, in the `BUNDLED_WORKFLOWS` map, after the line `'archon-workflow-builder': archonWorkflowBuilderWf,` add:

```typescript
  'archon-slack-feature-to-review-app': archonSlackFeatureToReviewAppWf,
```

- [ ] **Step 3: Inspect the existing test for a count assertion**

Run:

```bash
grep -n "13\|BUNDLED_WORKFLOWS\|toHaveLength\|Object.keys" packages/workflows/src/defaults/bundled-defaults.test.ts
```

If you see an assertion like `expect(Object.keys(BUNDLED_WORKFLOWS)).toHaveLength(13)`, update the `13` to `14`.

If there is no count assertion (the test just iterates and parses), no test change is needed — the new entry is covered automatically.

- [ ] **Step 4: Run the bundled-defaults test**

Run:

```bash
cd packages/workflows && bun test src/defaults/bundled-defaults.test.ts
```

Expected: all tests pass, including the parse check on the new workflow.

If parsing fails because the workflow references a command not present in `BUNDLED_COMMANDS`, that means binary builds need the command too. Add the missing command's import and map entry to `BUNDLED_COMMANDS` following the same pattern as the other 21 commands in that file.

- [ ] **Step 5: Type-check**

From repo root:

```bash
bun run type-check
```

Expected: no new type errors. The `with { type: 'text' }` import syntax is already used 34 times in this file.

- [ ] **Step 6: Commit**

```bash
git add packages/workflows/src/defaults/bundled-defaults.ts \
        packages/workflows/src/defaults/bundled-defaults.test.ts
git commit -m "feat(workflows): register archon-slack-feature-to-review-app in bundled defaults

Make the new end-to-end Slack workflow available in binary builds alongside
the existing bundled workflows."
```

---

### Task 6: Pre-PR validation

No new code; run the project's standard validation gate.

- [ ] **Step 1: Run full validation**

From repo root:

```bash
bun run validate
```

Expected: type-check, lint, format, and tests all pass.

- [ ] **Step 2: Fix any flagged issues inline**

If lint flags anything in the new script files, fix inline. Do not silence warnings with `eslint-disable` — the repo enforces zero warnings per `CLAUDE.md`.

- [ ] **Step 3: Commit fixups (only if needed)**

```bash
git status --short
```

If anything changed in step 2:

```bash
git add -A
git commit -m "chore: fix lint/format for new slack feature workflow"
```

Otherwise skip.

---

### Task 7: Manual smoke test (one-time, after merge)

Verification checklist to run ONCE against a real Slack workspace after merge. Not part of CI. Document outcomes in the PR description.

- [ ] **Step 1: Confirm environment**

Check `.env` contains:
- `SLACK_BOT_TOKEN` (xoxb-*)
- `SLACK_APP_TOKEN` (xapp-*)
- `SLACK_ALLOWED_USER_IDS` including your Slack user ID
- `ANTHROPIC_API_KEY`
- `GITHUB_TOKEN` with workflow dispatch permissions on the target repo

Confirm a codebase pointing at the target repo is registered in Archon.

Start the server:

```bash
bun run dev
```

- [ ] **Step 2: Trigger with a trivial request**

In the connected Slack channel, post:

```
@archie add a README badge linking to the docs site
```

- [ ] **Step 3: Verify spec phase**

Expected in-thread:
1. Bot restates the request and asks 3-5 targeted questions.
2. Reply with answers.
3. Bot drafts a spec summary and asks for approval.
4. Reply `approved`.
5. Announce: `🧠 Spec approved. Creating implementation plan...` appears.

- [ ] **Step 4: Verify implement + PR**

Expected announces, in order:
1. `🏗️  Plan ready. Implementing in a fresh worktree...`
2. `✅ Implementation passed local validation. Opening PR...`
3. `🔍 PR opened. Running code review (round 1 of 2)...`

Confirm a real PR exists in the target repo with the generated branch.

- [ ] **Step 5: Verify review loop**

Expected either:
- `✅ Review round 1 clean. Waiting on CI...` (clean path)

or:
- `🔧 Review round 1 found N blocking issue(s). Applying fixes...`
- `🔍 Re-reviewing after fixes...`
- Then one of:
  - `✅ Review clean (round 2). Waiting on CI...`
  - `⛔ Code review did not converge after 2 rounds.` (terminal)

- [ ] **Step 6: Verify CI + deploy**

Expected:
- `🚀 CI green. Deploying review app...`
- `deploy-to-review-app.yml` workflow run appears in GitHub Actions for the PR branch.

- [ ] **Step 7: Verify URL fetch + final post**

Expected within 15 minutes:
- Final message: `🎉 Done! • PR: <url> • Review app: <url>`
- Clicking the review-app URL loads the deployed app.

- [ ] **Step 8: Record results in the PR description**

Add a `## Smoke test` section with pass/fail per step, links to the Slack thread, and any follow-ups discovered.

---

## Self-Review Notes

**Spec coverage check** — each design doc section maps to a task:
- Trigger + routing: no work needed (existing Slack adapter + router).
- Configuration: deferred; values hardcoded in YAML for v1 (documented divergence below).
- Workflow node graph phases A–I: Task 4.
- Progress announcements: inline in Task 4 (bash echo nodes).
- Authorization: no work needed (existing `SLACK_ALLOWED_USER_IDS`).
- Failure modes: script exit codes in Tasks 1–3; `review-gate` bash node in Task 4 handles the 2-round cap.
- Testing: Task 5 (bundled-defaults parse test) + Task 7 (manual smoke). Unit tests for scripts dropped; justified below.
- Implementation artifacts: Tasks 1–5.

**Placeholder scan:** No `TBD`, `TODO`, or "implement later" markers. Exact commands and complete code in every code step.

**Type consistency check:** Script CLI signatures (`process.argv` contracts) match the `bash:` wrapper invocations in Task 4. Script file names (`dispatch-review-app.ts`, `ci-wait.ts`, `fetch-review-app-url.ts`) match across Tasks 1–3 and the workflow invocations in Task 4.

**Divergence from design doc (noted for reviewers):**

1. **Code-review "2 rounds" unrolled** into explicit nodes rather than a `loop:` node, because loop bodies are single-prompt and cannot wrap the 5-parallel-agents sub-graph. Same net behavior, more verbose YAML.
2. **`reviewApp` config schema dropped for v1.** Values hardcoded in the YAML (`deploy-to-review-app.yml`, `*.review.instrumentl.com` regex). Per-project overrides become work when the second project opts in.
3. **Unit tests for helper scripts dropped.** No existing test pattern for `.archon/scripts/` (the existing `echo-*.js` files have none), and writing one would require new scaffolding. Workflow-level parse test + manual smoke test + defensive script arg validation provide pragmatic coverage.
