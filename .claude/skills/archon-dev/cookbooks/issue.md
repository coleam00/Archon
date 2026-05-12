# Issue Cookbook

Create well-structured GitHub issues from conversation context. Classifies bug vs feature, finds the right template, validates with a subagent, and submits via `gh`.

**Input**: `$ARGUMENTS` — description of the bug or feature, or omit to use recent conversation context.

---

## Phase 1: CLASSIFY — Bug or Feature?

### 1.1 Determine Issue Type

Analyze `$ARGUMENTS` and recent conversation context:

| Signal | Type |
|--------|------|
| Error, crash, unexpected behavior, regression, broken | **bug** |
| New capability, improvement, enhancement, "would be nice" | **feature** |
| Unclear | ASK the user: "Is this a bug report or a feature request?" |

### 1.2 Extract Key Details

From the conversation context, gather:

**For bugs:**
- What broke (symptom)
- Steps that triggered it (repro)
- Expected vs actual behavior
- Error messages or stack traces
- Which platform/workflow was involved

**For features:**
- The problem being solved
- Who it affects
- Proposed solution (if discussed)

**CHECKPOINT**: Issue type determined. Key details extracted from conversation.

---

## Phase 2: DISCOVER — Find Template and Context

### 2.1 Find Issue Template

```bash
ls .github/ISSUE_TEMPLATE/ 2>/dev/null
```

| Type | Template |
|------|----------|
| bug | `.github/ISSUE_TEMPLATE/bug_report.md` |
| feature | `.github/ISSUE_TEMPLATE/feature_request.md` |

Read the matching template. If no template found, scan `.github/` subfolders. If still none, use a sensible default format.

### 2.2 Gather Codebase Context

Launch a subagent to gather evidence relevant to the issue:

**For bugs** — Validate and locate:
- Search for the error message or symptom in the codebase
- Identify the file(s) and function(s) involved
- Check recent git history for related changes: `git log --oneline -20 --all -- {relevant paths}`
- Determine the package and module scope
- Note any related open issues: `gh issue list --search "{keywords}" --limit 5`

**For features** — Find integration points:
- Identify which package(s) would be affected
- Find the interfaces or modules the feature would touch
- Check for existing partial implementations or TODOs
- Note any related open issues: `gh issue list --search "{keywords}" --limit 5`

**CHECKPOINT**: Template loaded. Codebase context gathered. No duplicate issues found.

---

## Phase 3: DRAFT — Fill the Template

Fill every section of the template using the extracted details and subagent findings.

### Bug Report Sections

| Section | Source |
|---------|--------|
| Summary | Conversation context — what broke, severity |
| Steps to Reproduce | User's repro steps or inferred from context |
| Expected vs Actual | From conversation |
| User Flow | Draw ASCII diagram showing where things break (mark with `[X]`) |
| Environment | Detect from context or ask user |
| Logs | Any error output from the conversation |
| Impact | Affected workflows, repro rate, workaround if known |
| Scope | Package + module from subagent findings |

### Feature Request Sections

| Section | Source |
|---------|--------|
| Problem | From conversation — what, who, how often |
| Proposed Solution | From conversation or subagent findings |
| User Flow (before/after) | Draw ASCII diagrams showing current pain and proposed improvement |
| Alternatives Considered | From conversation or subagent research |
| Scope | Packages affected, breaking changes, DB changes from subagent |
| Security Considerations | Assess from the nature of the feature |
| Definition of Done | Draft acceptance criteria based on the proposed solution |

### Draft Rules

- Write clearly and concisely — an engineer who wasn't in this conversation should understand the issue
- Include `file:line` references from subagent findings where relevant
- Don't speculate about root cause in bug reports — state symptoms and evidence
- For features, be specific about what "done" looks like

**CHECKPOINT**: All template sections filled. Issue is self-contained and actionable.

---

## Phase 4: REVIEW — Validate the Draft

Present the full draft to the user before submitting:

```markdown
## Issue Preview ({bug|feature})

**Title**: {title}

{full issue body}

---

Ready to submit? (Y/n)
```

If the user requests changes, revise and re-present.

---

## Phase 5: SUBMIT — Create the Issue

### 5.1 Determine Labels

Based on classification and scope:

```bash
# Bug
gh issue create --label "bug" --label "{package-scope}" ...

# Feature
gh issue create --label "enhancement" --label "{package-scope}" ...
```

### 5.2 Create the Issue

```bash
gh issue create \
  --title "{title}" \
  --label "{labels}" \
  --body "$(cat <<'EOF'
{filled template body}
EOF
)"
```

### 5.3 Verify

```bash
gh issue view --json number,url,title,labels
```

---

## Phase 6: REPORT — Summary

```markdown
## Issue Created

**Issue**: #{number}
**URL**: {url}
**Title**: {title}
**Type**: {bug|feature}
**Labels**: {labels}

### Context Gathered

- Package: {package}
- Module: {module}
- Related issues: {links or "None"}

### Next Steps

- {For bugs}: `/archon-dev debug #{number}` to investigate
- {For features}: `/archon-dev prd` to write requirements, or `/archon-dev plan` to design
```

---

## Examples

```
/archon-dev issue                              # Use recent conversation context
/archon-dev report this to gh                  # Same — infer from context
/archon-dev log this bug in github             # Bug from context
/archon-dev create a feature request for X     # Feature with description
/archon-dev gh issue: streaming breaks on large responses  # Bug with description
```
