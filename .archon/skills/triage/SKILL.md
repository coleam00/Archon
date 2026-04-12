---
name: triage
description: |
  Triage GitHub issues by applying type, effort, priority, and area labels.
  Runs in an isolated context to avoid polluting the main conversation with
  issue details. Delegates to a specialized triage agent with label validation hooks.
argument-hint: "[unlabeled|all|N|N-M]"
disable-model-invocation: true
context: fork
agent: triage-agent
allowed-tools: Bash(gh *), Read, Glob, Grep
---

# Triage GitHub Issues

Triage issues for this repository by applying appropriate labels.

## Repository Context

- **Current repo**: !`gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "unknown"`
- **Open issues**: !`gh issue list --state open --json number --jq 'length' 2>/dev/null || echo "?"`
- **Existing labels**: !`gh label list --json name -q '.[].name' 2>/dev/null | head -20 || echo "none found"`

---

## Scope

Determine which issues to triage based on the arguments: **$ARGUMENTS**

| Argument | Behavior |
|----------|----------|
| (empty) | Only unlabeled issues (default) |
| `unlabeled` | Only issues without any labels |
| `all` | All open issues |
| `N` | Specific issue (e.g., `67`) |
| `N-M` | Range of issues inclusive (e.g., `60-67`) |

## Process

1. **Fetch available labels** — run `gh label list --json name,description` to understand
   the label taxonomy. Labels are organized into type, effort, priority, and area categories.

2. **Fetch target issues** — based on the scope above. For each issue, fetch the full body:
   ```bash
   gh issue view {number} --json number,title,body,labels
   ```

3. **For each issue**:
   - Read the title and full body carefully
   - If needed, explore the codebase (`Glob`, `Grep`, `Read`) to understand the affected code
   - Classify: one type, one effort, one priority, one or more areas
   - Track relationships with other issues (duplicates, related, blocking)
   - Apply labels:
     ```bash
     gh issue edit {number} --add-label "type,effort/level,P#,area.domain"
     ```
   - Skip issues that already have complete labeling (type + effort + priority + area)
   - For partially labeled issues, only add missing label categories

4. **Output a triage summary**:

   ```
   ## Triage Summary

   | Issue | Title | Labels Applied | Reasoning |
   |-------|-------|----------------|-----------|
   | #67 | ... | bug, effort/low, P1, core.config | ... |

   **Totals:**
   - Issues triaged: X
   - Already labeled (skipped): Y
   - By priority: P0(n), P1(n), P2(n), P3(n)

   ## Relationships Discovered

   | Issues | Relationship | Notes |
   |--------|--------------|-------|
   | #61, #62 | Related | Both involve config/logging UX |
   ```

## Rules

- **Don't hardcode labels** — always fetch current labels first, they may change
- **Respect existing labels** — don't remove labels, only add missing ones
- **Check issue body** — titles alone aren't enough context
- **Use the codebase** — if understanding a relationship requires seeing how modules connect, look
- **When uncertain, note it** — flag ambiguous issues in the summary rather than guessing
