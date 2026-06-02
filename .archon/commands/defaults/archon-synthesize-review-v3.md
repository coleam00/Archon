---
description: V3 — Aggregate JSON findings from reviewers, emit synthesis.json contract; auto-fix list includes ALL severities (CRITICAL/HIGH/MEDIUM/LOW)
argument-hint: (none — reads $ARTIFACTS_DIR/review/*-findings.json)
---

## CRITICAL — Tool-use enforcement

You MUST use the Write tool to persist `synthesis.json` AND `synthesis.md`.
Do NOT describe findings, ask questions, or wait for user input — invoke
Write. The downstream `pre-fix-gate` will hard-fail if synthesis.json is
missing.

This command MUST end with BOTH files Written:
- `$ARTIFACTS_DIR/review/synthesis.json` (machine-readable contract)
- `$ARTIFACTS_DIR/review/synthesis.md`   (human-readable summary)

If you found zero reviewer JSONs on disk, STILL Write synthesis.json with
`{"agents_completed": 0, "agents_failed": <N>, "blocking_findings": [], "verdict": "BLOCK", ...}` so the gate can deterministically see the empty state.

NEVER end your turn by asking "would you like me to check elsewhere?" —
you have all the context needed; if data is missing, record that fact in
the JSON and exit.

---

# Synthesize Review (v3 — "fix every single one")

You are aggregating structured findings from up to 5 reviewer agents into a single canonical contract that downstream nodes consume. **You write JSON, not English.**

**v3 deviation from v2:** the `blocking_findings` list (which feeds the auto-fix loop) now includes **all severities** — `CRITICAL`, `HIGH`, `MEDIUM`, **and `LOW`**. The intent: every finding the reviewers produced should be auto-fixed, not just the top two tiers. The verdict rule still uses the severity tiers so the merge gate escalates sensibly (a CRITICAL still BLOCKs; LOWs no longer fail the BLOCK check just by existing in `blocking_findings`).

## Phase 1: LOAD

```bash
cd $ARTIFACTS_DIR/review
ls -la *-findings.json
```

For each agent in (`code-review`, `error-handling`, `test-coverage`, `comment-quality`, `docs-impact`):
- If `<agent>-findings.json` exists and parses → mark agent as completed, load its findings
- If missing or unparseable → mark agent as failed, capture the reason

Use `jq` to parse, never your own JSON parsing — if `jq` rejects it, the file is invalid.

```bash
for agent in code-review error-handling test-coverage comment-quality docs-impact; do
  f="$agent-findings.json"
  if [ -f "$f" ] && jq empty "$f" 2>/dev/null; then
    echo "OK: $agent"
  else
    echo "MISSING_OR_INVALID: $agent"
  fi
done
```

## Phase 2: DEDUPLICATE

Multiple reviewers often produce overlapping findings (e.g., code-review and error-handling both flag the same swallowed catch). Deduplicate by `(file, line, category-family)`:

- **Family map**: `bug` ↔ `regression`; `swallowed-error` ↔ `silent-fallback` ↔ `lost-context`; `headline-untested` ↔ `branch-untested`
- When two findings overlap, keep the one with the **highest severity**, merge `evidence` sections, and credit both agents in a `reported_by` array

## Phase 3: BUILD synthesis.json

Write `$ARTIFACTS_DIR/review/synthesis.json`. EXACT schema:

```json
{
  "pr_number": <int>,
  "agents_completed": <int>,            // count that produced valid JSON
  "agents_failed": <int>,                // count that didn't
  "failed_agents": [<list of names>],
  "all_findings": [
    {
      "id": "<agent>-<n>",                // preserve original agent ids
      "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
      "category": "<from reviewer>",
      "title": "...",
      "file": "...",
      "line": <int>,
      "evidence": "...",
      "why_it_matters": "...",
      "recommended_fix": "...",
      "confirmation_check": "<bash command or 'MANUAL'>",
      "in_scope": true | false,
      "reported_by": ["code-review", "error-handling"],
      "duplicates": ["error-handling-3"]   // ids merged into this finding
    }
  ],
  "blocking_findings": [<subset where severity in (CRITICAL, HIGH, MEDIUM, LOW) AND in_scope>],
  "blocking_count": <int>,
  "stats": {
    "critical": <int>,
    "high": <int>,
    "medium": <int>,
    "low": <int>,
    "out_of_scope_critical_high": <int>   // surface separately, don't auto-fix
  },
  "verdict": "BLOCK" | "APPROVE_WITH_FIXES" | "APPROVE",
  "verdict_reason": "<one-line explanation>",
  "v3_widened_to_all_severities": true
}
```

**v3 widening note**: `blocking_findings` now includes every in-scope finding of any severity, including `LOW`. This is what makes the auto-fix loop fix every single thing the reviewers flagged, not just the high-impact ones. The verdict rule below still uses severity tiers, so the merge gate escalates sensibly — only CRITICAL actually blocks the merge approval.

**Verdict rule** (unchanged from v2 — severity-based escalation of the gate, not the fix list):
- `BLOCK` — `agents_completed < 2`, or any `in_scope` finding with severity `CRITICAL`
- `APPROVE_WITH_FIXES` — any `in_scope` `HIGH` (or anything to fix), zero `CRITICAL`
- `APPROVE` — no `in_scope` `CRITICAL` or `HIGH` findings (LOW-only is fine to merge after auto-fix)

## Phase 4: ALSO emit consolidated markdown for humans

Write `$ARTIFACTS_DIR/review/synthesis.md` — short narrative summary:
- Verdict + reason
- Stats table (now including LOW counts explicitly so humans see the full surface area)
- The blocking_findings list with file:line and one-line fix — grouped by severity (CRITICAL → HIGH → MEDIUM → LOW) so a human skimming the doc sees the highest-impact items first
- Out-of-scope CRITICAL/HIGH findings called out separately ("flagged but not auto-fixed")
- Failed agents (with reason)

## Phase 5: VALIDATE

```bash
jq -e '
  .pr_number and
  (.agents_completed | type == "number") and
  (.all_findings | type == "array") and
  (.blocking_findings | type == "array") and
  (.stats.critical | type == "number") and
  (.verdict | IN("BLOCK", "APPROVE_WITH_FIXES", "APPROVE"))) and
  (.v3_widened_to_all_severities == true)
' $ARTIFACTS_DIR/review/synthesis.json
```

If `jq` fails, your synthesis.json is malformed — re-emit before terminating.

## Success Criteria

- `synthesis.json` exists and passes the jq schema check (including the `v3_widened_to_all_severities: true` marker)
- Every finding in `all_findings` includes `reported_by` and (if merged) `duplicates`
- `blocking_count == blocking_findings.length` (sanity check — and in v3 this includes LOWs)
- `verdict` follows the rule above (don't soften BLOCK to APPROVE_WITH_FIXES because it "feels safer")
