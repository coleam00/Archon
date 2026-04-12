---
description: Generate implementation report reflecting on completed work
---

# Execution Report

Review and deeply analyze the implementation you just completed.

## Context

You have just finished implementing a feature or fix. Before moving on, reflect on:

- What you implemented
- How it aligns with the plan
- What challenges you encountered
- What diverged and why

## Generate Report

Save to: `.agents/execution-reports/[feature-name].md`

### Meta Information

- Plan file: [path to plan that guided this implementation]
- Feature: [brief description]
- Files added: [list with full paths]
- Files modified: [list with full paths]
- Lines changed: +X -Y

### Validation Results

```
Type Checking:  ✅/❌ [details if failed]
Linting:        ✅/❌ [details if failed]
Formatting:     ✅/❌ [details if failed]
Tests:          ✅/❌ [X passed, Y failed]
Full Validate:  ✅/❌ [bun run validate result]
```

### What Went Well

List specific things that worked smoothly:
- [concrete examples from this implementation]

### Challenges Encountered

List specific difficulties:
- [what was difficult and why, with file:line references]

### Divergences from Plan

For each divergence, document:

**[Divergence Title]**
- Planned: [what the plan specified]
- Actual: [what was implemented instead]
- Reason: [why this divergence occurred]
- Type: [Better approach found | Plan assumption wrong | Security concern | Performance issue | Package boundary constraint | Other]

### Skipped Items

List anything from the plan that was not implemented:
- [what was skipped]
- Reason: [why it was skipped]

### Archon-Specific Observations

- Package boundaries respected: [yes/no — any cross-package concerns?]
- Mock isolation: [any new mock.module() calls? Do they need separate test batches?]
- Import patterns: [any tricky import situations?]

### Recommendations

Based on this implementation, what should change for next time?
- Plan command improvements: [suggestions]
- Execute command improvements: [suggestions]
- CLAUDE.md additions: [suggestions]
- `.claude/rules/` updates: [suggestions]
