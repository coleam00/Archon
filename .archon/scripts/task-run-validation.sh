#!/usr/bin/env bash
#
# Deterministic test runner — invoked between implementation attempts. Runs
# lint, typecheck, scoped Vitest, and scoped Playwright. Always writes the raw
# per-attempt report; the workflow's validate-* node turns that evidence into
# product-level feedback for the next dev/fix attempt.
#
# Exit code: always 0. The bash node emits a JSON `passed` field and the
# workflow routes based on that output.
#
# Required env (set by the workflow's prepared environment):
#   ARTIFACTS_DIR  — workflow's artifacts directory
#   ISSUE_KEY      — Jira ticket key (selects which test scope to run)
#
# Policy:
# - Blocking gates for task-implement are the ticket-scoped test suites
#   (Vitest + Playwright under ISSUE_KEY scope).
# - Lint/typecheck are blocking only when failures reference THIS ticket's
#   scope: files under tests/<ISSUE_KEY>/ and e2e/<ISSUE_KEY>/ (case-insensitive),
#   OR files that appear in git diff baseline..HEAD for this run (so prod code
#   the dev touched is still enforced). Failures that only mention other
#   tickets' tests (e.g. tests/wor-41) are logged but non-blocking.
#
set -uo pipefail

# Redirect ALL of this script's narrative output (gate banners, tail dumps,
# pass/fail markers) to stderr, leaving stdout for the single trailing JSON
# line. The bash node's stdout is what gets captured into the workflow's
# nodeOutput; downstream `when:` clauses parse it as JSON, so any prose on
# stdout makes JSON.parse fail and the condition evaluates to ''.
exec 3>&1 1>&2

ARTIFACTS_DIR="${ARTIFACTS_DIR:?ARTIFACTS_DIR not set}"

# Pin validation to the same checkout/worktree for the entire run.
# First validation call records repo root; subsequent calls must match.
CURRENT_REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
WORKTREE_PIN_FILE="$ARTIFACTS_DIR/.validation-worktree-root"
if [ -f "$WORKTREE_PIN_FILE" ]; then
  EXPECTED_REPO_ROOT="$(cat "$WORKTREE_PIN_FILE")"
  if [ "$CURRENT_REPO_ROOT" != "$EXPECTED_REPO_ROOT" ]; then
    echo "Validation checkout mismatch." >&2
    echo "Expected repo root: $EXPECTED_REPO_ROOT" >&2
    echo "Current repo root:  $CURRENT_REPO_ROOT" >&2
    exit 1
  fi
else
  printf '%s' "$CURRENT_REPO_ROOT" > "$WORKTREE_PIN_FILE"
fi

# Capture a stable baseline commit for this workflow run so we can attribute
# lint/typecheck failures to "files changed by this implementation attempt set".
BASELINE_SHA_FILE="$ARTIFACTS_DIR/.validation-baseline-sha"
if [ -f "$BASELINE_SHA_FILE" ]; then
  BASELINE_SHA="$(cat "$BASELINE_SHA_FILE")"
else
  BASELINE_SHA="$(git rev-parse HEAD)"
  printf '%s' "$BASELINE_SHA" > "$BASELINE_SHA_FILE"
fi

CHANGED_FILES_FILE="$ARTIFACTS_DIR/.validation-changed-files.txt"
git diff --name-only "$BASELINE_SHA"...HEAD > "$CHANGED_FILES_FILE" || true

# Read ISSUE_KEY from the trigger payload — single source of truth, written
# once by the decode node, no env-var passing or shell-quoting concerns.
ISSUE_KEY=$(bun -e "
  import { readFileSync } from 'node:fs';
  const p = JSON.parse(readFileSync('${ARTIFACTS_DIR}/trigger-payload.json', 'utf8'));
  process.stdout.write(p.issue_key);
")
if [ -z "$ISSUE_KEY" ]; then
  echo "ISSUE_KEY missing from $ARTIFACTS_DIR/trigger-payload.json" >&2
  exit 1
fi

# Auto-detect the attempt number by counting existing per-attempt reports.
# validate-1 finds 0, writes attempt-1; validate-2 finds 1, writes attempt-2;
# post-fix-validation finds 2, writes attempt-3. No env-var coordination needed.
existing=$(ls "$ARTIFACTS_DIR"/feedback.attempt-*.json 2>/dev/null | wc -l)
ATTEMPT_NUM=$((existing + 1))

# Resolve the per-ticket test directory case-insensitively. The Jira key is
# uppercase (WOR-23) but test-gen agents have scaffolded tests under both
# tests/WOR-23/ and tests/wor-23/ on different runs; rather than fight that,
# locate whichever exists. Falls back to the lowercase form if neither
# exists, so the SKIP message is consistent.
find_ticket_dir() {
  local parent="$1"
  local key_lc key_uc
  key_lc=$(echo "$ISSUE_KEY" | tr '[:upper:]' '[:lower:]')
  key_uc=$(echo "$ISSUE_KEY" | tr '[:lower:]' '[:upper:]')
  if [ -d "$parent/$ISSUE_KEY" ]; then echo "$parent/$ISSUE_KEY"
  elif [ -d "$parent/$key_lc" ]; then echo "$parent/$key_lc"
  elif [ -d "$parent/$key_uc" ]; then echo "$parent/$key_uc"
  else echo "$parent/$key_lc"  # fallback for the SKIP message
  fi
}

VITEST_DIR=$(find_ticket_dir tests)
PLAYWRIGHT_DIR=$(find_ticket_dir e2e)

# Per-attempt artifact paths. validate-1 writes to feedback.attempt-1.json
# and test-results/attempt-1/; validate-2 writes to attempt-2 paths. The
# canonical feedback.json is also written (a copy of the latest attempt)
# so dev-attempt-2's prompt can reference a stable path. The per-attempt
# files are the audit trail: each attempt's evidence is preserved.
ATTEMPT_RESULTS_DIR="$ARTIFACTS_DIR/test-results/attempt-$ATTEMPT_NUM"
mkdir -p "$ATTEMPT_RESULTS_DIR"
REPORT="$ARTIFACTS_DIR/feedback.attempt-$ATTEMPT_NUM.json"
CANONICAL_REPORT="$ARTIFACTS_DIR/feedback.json"

# Build the gates list incrementally as a JSON string.
GATES_JSON="[]"

add_gate() {
  local name="$1" status="$2" log_file="$3" blocking="$4" relevant="$5"
  GATES_JSON=$(NAME="$name" STATUS="$status" LOG_FILE="$log_file" BLOCKING="$blocking" RELEVANT="$relevant" GATES_JSON="$GATES_JSON" bun -e '
    import { readFileSync } from "node:fs";
    const gates = JSON.parse(process.env.GATES_JSON || "[]");
    let log = "";
    try { log = readFileSync(process.env.LOG_FILE, "utf8"); } catch {}
    // Cap each gate log at 8000 chars (last bytes — failure tail is what matters).
    gates.push({
      name: process.env.NAME,
      status: process.env.STATUS,
      blocking: process.env.BLOCKING === "true",
      relevant_to_changed_files: process.env.RELEVANT === "true",
      log: log.length > 8000 ? log.slice(-8000) : log,
    });
    console.log(JSON.stringify(gates));
  ')
}

run_gate() {
  local name="$1" cmd="$2" blocking="${3:-false}" relevant="${4:-false}"
  local log_file="$ATTEMPT_RESULTS_DIR/${name}.log"

  echo "──────────────────────────────────────────────────────────────────"
  echo "GATE: $name"
  echo "──────────────────────────────────────────────────────────────────"
  bash -c "$cmd" > "$log_file" 2>&1
  local rc=$?
  if [ $rc -eq 0 ]; then
    echo "✓ $name PASSED"
    add_gate "$name" "passed" "$log_file" "$blocking" "$relevant"
    return 0
  else
    echo "✗ $name FAILED (exit $rc). Last 40 lines of output:"
    tail -40 "$log_file" | sed 's/^/  /'
    add_gate "$name" "failed" "$log_file" "$blocking" "$relevant"
    return 1
  fi
}

skip_gate() {
  local name="$1" reason="$2"
  echo "── SKIP: $name ($reason) ──"
  add_gate "$name" "skipped" "/dev/null" "false" "false"
}

has_script() {
  local script_name="$1"
  if [ ! -f package.json ]; then
    return 1
  fi
  bun -e "
    import { readFileSync } from 'node:fs';
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    process.exit(pkg.scripts && pkg.scripts['$script_name'] ? 0 : 1);
  " 2>/dev/null
}

OVERALL=0

# Exit 0 if lint/typecheck log contains at least one failure in this ticket's
# scope (tests/<key>/, e2e/<key>/) or in a file changed since baseline..HEAD.
log_has_task_scoped_failures() {
  local log_file="$1"
  CHANGED_FILES_FILE="$CHANGED_FILES_FILE" LOG_FILE="$log_file" REPO_ROOT="$CURRENT_REPO_ROOT" ISSUE_KEY="$ISSUE_KEY" bun -e '
    import { readFileSync } from "node:fs";

    const issueKey = process.env.ISSUE_KEY ?? "";
    const issueLc = issueKey.toLowerCase();
    const repoRoot = (process.env.REPO_ROOT ?? "").replace(/\/+$/, "");
    const logPath = process.env.LOG_FILE;
    const changedPath = process.env.CHANGED_FILES_FILE;
    if (!logPath || !changedPath) process.exit(1);
    const log = readFileSync(logPath, "utf8");
    const changedRaw = readFileSync(changedPath, "utf8");
    const changed = new Set(
      changedRaw
        .split(/\r?\n/)
        .map((s) => s.trim().replace(/\\/g, "/"))
        .filter(Boolean),
    );

    function toRel(p) {
      let s = p.trim().replace(/\\/g, "/");
      if (repoRoot && s.startsWith(repoRoot + "/")) s = s.slice(repoRoot.length + 1);
      return s;
    }

    function inTicketTestScope(rel) {
      const a = rel.toLowerCase();
      const seg1 = "tests/" + issueLc + "/";
      const seg2 = "e2e/" + issueLc + "/";
      const seg3 = "tests/" + issueKey + "/";
      const seg4 = "e2e/" + issueKey + "/";
      return (
        a.includes(seg1) ||
        a.includes(seg2) ||
        a.includes(seg3.toLowerCase()) ||
        a.includes(seg4.toLowerCase())
      );
    }

    const seen = new Set();
    function addPath(raw) {
      const rel = toRel(raw);
      if (
        rel &&
        (rel.endsWith(".ts") ||
          rel.endsWith(".tsx") ||
          rel.endsWith(".js") ||
          rel.endsWith(".jsx") ||
          rel.endsWith(".mjs") ||
          rel.endsWith(".cjs"))
      )
        seen.add(rel);
    }

    // TypeScript: path(line,col): error
    for (const m of log.matchAll(
      /([^\s(]+\.(?:tsx?|jsx?|mjs|cjs))\((\d+),(\d+)\):\s*(?:error|warning)/gi,
    )) {
      addPath(m[1]);
    }
    // TypeScript / ESLint: path:line:col
    for (const m of log.matchAll(/([^\s:]+\.(?:tsx?|jsx?|mjs|cjs)):\d+:\d+/g)) {
      addPath(m[1]);
    }
    // ESLint stylish: path-only line (often absolute)
    for (const m of log.matchAll(/^\s*(\/[^\s()]+\.(?:tsx?|jsx?|mjs|cjs))\s*$/gm)) {
      addPath(m[1]);
    }

    let blocking = false;
    for (const rel of seen) {
      if (inTicketTestScope(rel)) {
        blocking = true;
        break;
      }
      if (changed.has(rel)) {
        blocking = true;
        break;
      }
    }

    process.exit(blocking ? 0 : 1);
  ' 2>/dev/null
}

run_quality_gate_task_scoped() {
  local name="$1" cmd="$2"
  local log_file="$ATTEMPT_RESULTS_DIR/${name}.log"
  local rc=0
  local relevant="false"
  local blocking="false"

  echo "──────────────────────────────────────────────────────────────────"
  echo "GATE: $name"
  echo "──────────────────────────────────────────────────────────────────"
  bash -c "$cmd" > "$log_file" 2>&1 || rc=$?

  if [ "$rc" -eq 0 ]; then
    echo "✓ $name PASSED"
    add_gate "$name" "passed" "$log_file" "false" "false"
    return 0
  fi

  echo "✗ $name FAILED (exit $rc). Last 40 lines of output:"
  tail -40 "$log_file" | sed 's/^/  /'
  if log_has_task_scoped_failures "$log_file"; then
    relevant="true"
    blocking="true"
    OVERALL=1
    echo "✗ $name has failures in this ticket scope or in changed files (blocking)."
  else
    echo "ℹ $name failed only outside this ticket scope (non-blocking)."
  fi
  add_gate "$name" "failed" "$log_file" "$blocking" "$relevant"
  return 0
}

# 0. Deterministic generated-test cleanup
#
# Test-gen may temporarily suppress red-state missing implementation imports
# with @ts-expect-error. Once implementation exists, TypeScript reports those
# comments as TS2578. The dev agent cannot edit tests, so validation removes
# only TypeScript-proven obsolete directives from this ticket's generated test
# scope and commits the cleanup before the gates below run.
cleanup_log="$ATTEMPT_RESULTS_DIR/obsolete-ts-expect-error-cleanup.log"
if bun /home/user/Archon/.archon/scripts/task-cleanup-obsolete-ts-expect-error.ts > "$cleanup_log" 2>&1; then
  echo "✓ obsolete-ts-expect-error cleanup completed"
  add_gate "obsolete-ts-expect-error-cleanup" "passed" "$cleanup_log" "false" "false"
else
  echo "✗ obsolete-ts-expect-error cleanup failed. Last 40 lines of output:"
  tail -40 "$cleanup_log" | sed 's/^/  /'
  add_gate "obsolete-ts-expect-error-cleanup" "failed" "$cleanup_log" "true" "true"
  OVERALL=1
fi

# The cleanup may have committed generated-test fixes. Refresh the changed-file
# attribution set before lint/typecheck decide which failures are blocking.
git diff --name-only "$BASELINE_SHA"...HEAD > "$CHANGED_FILES_FILE" || true
echo

# 1. Lint
if has_script lint; then
  run_quality_gate_task_scoped "lint" "npm run lint"
else
  skip_gate "lint" "no script in package.json"
fi
echo

# 2. Typecheck
if has_script typecheck; then
  run_quality_gate_task_scoped "typecheck" "npm run typecheck"
else
  skip_gate "typecheck" "no script in package.json"
fi
echo

# 3. Vitest scoped to this ticket's tests (case-insensitive dir resolution)
if [ -d "$VITEST_DIR" ]; then
  run_gate "vitest" "npx vitest run $VITEST_DIR --reporter=default" "true" "true" || OVERALL=1
else
  skip_gate "vitest" "$VITEST_DIR/ does not exist"
fi
echo

# 4. Playwright scoped to this ticket's specs.
#
# DISABLED: Playwright runs in CI (deploy-preview.yml / ci.yml) against a
# real Convex deployment with proper env. Running it from this validator
# spawns a dev server, eats the bash node's 120s budget on slow E2E runs,
# and has cascaded into `fail-implementation-not-ready` even when
# lint/typecheck/vitest were green. CI is the right place; local
# validation gates only the deterministic-fast units. Re-enable here when
# the bash node has a longer timeout AND the dev server can be brought
# up reliably without flaky hooks.
if [ -d "$PLAYWRIGHT_DIR" ]; then
  skip_gate "playwright" "DISABLED in local validator — runs in CI instead"
else
  skip_gate "playwright" "$PLAYWRIGHT_DIR/ does not exist"
fi
echo

# Write the per-attempt report (feedback.attempt-N.json), then copy to the
# canonical feedback.json so dev-attempt-2's prompt can reference a stable
# path. The per-attempt files are the audit trail.
OVERALL_STATUS=$([ $OVERALL -eq 0 ] && echo passed || echo failed)
ATTEMPT_NUM="$ATTEMPT_NUM" ISSUE_KEY="$ISSUE_KEY" OVERALL_STATUS="$OVERALL_STATUS" GATES_JSON="$GATES_JSON" REPORT="$REPORT" CANONICAL_REPORT="$CANONICAL_REPORT" bun -e '
  import { writeFileSync } from "node:fs";
  const report = {
    attempt: Number(process.env.ATTEMPT_NUM),
    issue_key: process.env.ISSUE_KEY,
    overall: process.env.OVERALL_STATUS,
    gates: JSON.parse(process.env.GATES_JSON),
    generated_at: new Date().toISOString(),
  };
  const json = JSON.stringify(report, null, 2);
  writeFileSync(process.env.REPORT, json);
  writeFileSync(process.env.CANONICAL_REPORT, json);
  // Clean path-only line so any downstream consumer that turns it into a
  // URL gets a real URL — no parens, no spaces, no commentary.
  console.log(process.env.REPORT);
'

echo "══════════════════════════════════════════════════════════════════"
if [ $OVERALL -eq 0 ]; then
  echo "✓ ALL GATES PASSED for $ISSUE_KEY"
  echo "══════════════════════════════════════════════════════════════════"
  # Final JSON goes to the saved real stdout (fd 3) so it's the ONLY thing
  # downstream `when:` clauses see. Narrative is on stderr (fd 2).
  printf '{"passed":"true","issue_key":"%s","report":"%s"}\n' "$ISSUE_KEY" "$REPORT" >&3
else
  echo "✗ GATE(S) FAILED for $ISSUE_KEY — feedback.json written; next dev attempt will read it."
  echo "══════════════════════════════════════════════════════════════════"
  printf '{"passed":"false","issue_key":"%s","report":"%s"}\n' "$ISSUE_KEY" "$REPORT" >&3
fi
# Always exit 0. The DAG's `when:` clauses gate on the JSON output's passed field,
# not on the exit code. This lets downstream conditional nodes route on test
# outcome without the validation node itself being "failed" in DAG terms.
exit 0
