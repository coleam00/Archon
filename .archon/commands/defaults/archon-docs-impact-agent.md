---
description: Check if PR changes require documentation updates (CLAUDE.md, docs/, agents)
argument-hint: (none - reads from scope artifact)
---

# Documentation Impact Agent

---

## Your Mission

Analyze if the PR changes require updates to project documentation: CLAUDE.md, docs/ folder, agent definitions, or other documentation. Produce a structured artifact with recommendations.

**Output artifact**: `$ARTIFACTS_DIR/review/docs-impact-findings.md`

---

## Phase 1: LOAD - Get Context

### 1.1 Get PR Number from Registry

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number)
```

### 1.2 Read Scope

```bash
cat $ARTIFACTS_DIR/review/scope.md
```

**CRITICAL**: Check for "NOT Building (Scope Limits)" section. Items listed there are **intentionally excluded** - do NOT flag them as missing documentation needs!

### 1.3 Get PR Diff

```bash
gh pr diff {number}
```

### 1.4 Read Current Documentation

```bash
# Read CLAUDE.md
cat CLAUDE.md

# List docs folder
ls -la $DOCS_DIR

# List agent definitions
ls -la .claude/agents/ 2>/dev/null || true
ls -la .archon/commands/ 2>/dev/null || true
```

**PHASE_1_CHECKPOINT:**
- [ ] PR number identified
- [ ] Changes understood
- [ ] Current docs read

---

## Phase 2: ANALYZE - Check Documentation Impact

### 2.1 CLAUDE.md Impact

Check if changes affect documented:
- Commands or slash commands
- Workflows
- Development setup
- Environment variables
- Database schema
- API endpoints
- Testing instructions
- Code patterns/standards

### 2.2 docs/ Folder Impact

Check if changes affect:
- Architecture documentation
- Getting started guide
- Configuration documentation
- API documentation
- Deployment instructions

### 2.3 Agent/Command Definitions

Check if changes affect:
- Agent capabilities
- Command arguments
- Workflow steps
- Tool usage patterns

### 2.4 README Impact

Check if changes affect:
- Feature list
- Installation instructions
- Usage examples
- Configuration options

**PHASE_2_CHECKPOINT:**
- [ ] CLAUDE.md impact assessed
- [ ] docs/ impact assessed
- [ ] Agent definitions checked
- [ ] README checked

---

## Phase 3: GENERATE - Create Artifact

Write to `$ARTIFACTS_DIR/review/docs-impact-findings.md`:

```markdown
# Documentation Impact Findings: PR #{number}

**Reviewer**: docs-impact-agent
**Date**: {ISO timestamp}
**Docs Checked**: CLAUDE.md, docs/, agents, README

---

## Summary

{2-3 sentence overview of documentation impact}

**Verdict**: {NO_CHANGES_NEEDED | UPDATES_REQUIRED | CRITICAL_UPDATES}

---

## Impact Assessment

| Document | Impact | Required Update |
|----------|--------|-----------------|
| CLAUDE.md | NONE/LOW/HIGH | {description or "None"} |
| $DOCS_DIR/architecture.md | NONE/LOW/HIGH | {description or "None"} |
| $DOCS_DIR/configuration.md | NONE/LOW/HIGH | {description or "None"} |
| README.md | NONE/LOW/HIGH | {description or "None"} |
| .claude/agents/*.md | NONE/LOW/HIGH | {description or "None"} |
| .archon/commands/*.md | NONE/LOW/HIGH | {description or "None"} |

---

## Findings

### Finding 1: {Descriptive Title}

**Severity**: CRITICAL | HIGH | MEDIUM | LOW
**Category**: missing-docs | outdated-docs | incomplete-docs | misleading-docs
**Document**: `{file path}`
**PR Change**: `{source file}:{line}` - {what changed}

**Issue**:
{Clear description of why docs need updating}

**Current Documentation**:
```markdown
{current text in docs}
```

**Code Change**:
```typescript
// What changed in the PR
{new code that docs don't reflect}
```

**Impact if Not Updated**:
{What happens if docs aren't updated - user confusion, wrong setup, etc.}

---

#### Update Suggestions

| Option | Approach | Scope | Effort |
|--------|----------|-------|--------|
| A | {minimal update} | {what it covers} | LOW |
| B | {comprehensive update} | {what it covers} | MED/HIGH |

**Recommended**: Option {X}

**Reasoning**:
{Why this update approach:
- Keeps docs accurate
- Matches existing documentation style
- Appropriate level of detail}

**Suggested Documentation Update**:
```markdown
{what the docs should say after update}
```

**Documentation Style Reference**:
```markdown
# SOURCE: {doc file}
# How similar features are documented
{existing documentation pattern}
```

---

### Finding 2: {Title}

{Same structure...}

---

## CLAUDE.md Sections to Update

| Section | Current | Needed Update |
|---------|---------|---------------|
| {section name} | {current text summary} | {what to add/change} |
| ... | ... | ... |

---

## Statistics

| Severity | Count | Documents Affected |
|----------|-------|-------------------|
| CRITICAL | {n} | {list} |
| HIGH | {n} | {list} |
| MEDIUM | {n} | {list} |
| LOW | {n} | {list} |

---

## New Documentation Needed

| Topic | Suggested Location | Priority |
|-------|-------------------|----------|
| {new feature/change} | {where to document} | HIGH/MED/LOW |
| ... | ... | ... |

---

## Positive Observations

{Documentation already updated in PR, good inline docs, etc.}

---

## Metadata

- **Agent**: docs-impact-agent
- **Timestamp**: {ISO timestamp}
- **Artifact**: `$ARTIFACTS_DIR/review/docs-impact-findings.md`
```

**PHASE_3_CHECKPOINT:**
- [ ] Artifact file created
- [ ] All docs checked
- [ ] Update suggestions provided
- [ ] Existing doc style referenced

---

## Success Criteria

- **DOCS_ANALYZED**: All relevant docs checked
- **IMPACT_ASSESSED**: Each doc rated for impact
- **UPDATES_SPECIFIED**: Clear update suggestions
- **STYLE_MATCHED**: Suggestions match existing doc style
