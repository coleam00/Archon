---
description: Research web sources for context relevant to a GitHub issue or feature
argument-hint: <issue-number or search context>
---

# Web Research

**Input**: $ARGUMENTS
**Workflow ID**: $WORKFLOW_ID

---

## Your Mission

Search the web for information relevant to the issue or feature being worked on. Find official documentation, known issues, best practices, and solutions that will inform implementation.

**Output**: `$ARTIFACTS_DIR/web-research.md`

**Core Principle**: Search strategically, prioritize authoritative sources, cite everything.

---

## Phase 1: PARSE - Understand What to Research

### 1.1 Get Issue Context

If input looks like a GitHub issue number:

```bash
gh issue view $ARGUMENTS --json title,body,labels
```

### 1.2 Identify Research Targets

From the issue context, identify:

- Key technologies, libraries, or APIs mentioned
- Error messages or stack traces to search for
- Concepts or patterns that need clarification
- Version-specific documentation needs
- Existing primitives in the ecosystem — what built-in or library-level abstractions already solve part of this? (avoids reinventing)

### 1.3 Formulate Search Plan

Create 3-5 targeted search queries:

| Query | Why | Expected Source |
|-------|-----|-----------------|
| "{library} {feature} documentation" | Official docs | Library website |
| "{error message}" | Known issues | Stack Overflow, GitHub issues |
| "{pattern} best practices {year}" | Current approaches | Blog posts, docs |
| "{library} built-in {primitive/feature}" | Avoid reinventing | Official docs, changelog, migration guides |

**PHASE_1_CHECKPOINT:**

- [ ] Issue context understood
- [ ] Research targets identified
- [ ] Search queries formulated

---

## Phase 2: SEARCH - Execute Research

### 2.1 Check for llms.txt

Many sites publish LLM-optimized documentation:

```
Try fetching https://{domain}/llms.txt for any known site
Read the result and fetch relevant sub-pages linked within
```

### 2.2 Search Official Documentation

For each technology/library involved:

1. Search for official docs with version constraints
2. Use `site:` operator for known authoritative sources
3. Look for changelog/release notes for version info

### 2.3 Search for Known Issues

If the issue involves errors or bugs:

1. Search exact error messages in quotes
2. Check GitHub issues for the relevant libraries
3. Look for Stack Overflow answers

### 2.4 Search for Best Practices

If the issue involves implementation decisions:

1. Search for recognized patterns and approaches
2. Cross-reference multiple sources
3. Look for migration guides if changing approaches

**PHASE_2_CHECKPOINT:**

- [ ] At least 3 searches executed
- [ ] Authoritative sources found
- [ ] Relevant content extracted

---

## Phase 3: SYNTHESIZE - Compile Findings

### 3.1 Organize by Relevance

For each finding:

- **Source**: Name and URL
- **Authority**: Why this source is credible
- **Key information**: Direct quotes or specific facts
- **Applies to**: Which part of the issue this informs
- **Version/date**: Currency of the information

### 3.2 Identify Conflicts or Gaps

- Note any conflicting information between sources
- Flag outdated content
- Document what could NOT be found

**PHASE_3_CHECKPOINT:**

- [ ] Findings organized
- [ ] Conflicts noted
- [ ] Gaps documented

---

## Phase 4: GENERATE - Write Artifact

Write to `$ARTIFACTS_DIR/web-research.md`:

```markdown
# Web Research: $ARGUMENTS

**Researched**: {ISO timestamp}
**Workflow ID**: $WORKFLOW_ID

---

## Summary

{2-3 sentence overview of key findings}

---

## Findings

### {Source/Topic 1}

**Source**: [{Name}]({URL})
**Authority**: {Why credible}
**Relevant to**: {Which part of the issue}

**Key Information**:

- {Finding 1}
- {Finding 2}
- {Version/date context}

---

### {Source/Topic 2}

{Same structure...}

---

## Code Examples

{If applicable — actual code from sources with attribution}

```language
// From [{source}]({url})
{code example}
```

---

## Gaps and Conflicts

- {Information that couldn't be found}
- {Conflicting claims between sources}
- {Areas needing further investigation}

---

## Recommendations

Based on research:

1. {Recommendation 1 — what approach to take and why}
2. {Recommendation 2 — what to avoid and why}

---

## Sources

| # | Source | URL | Relevance |
|---|--------|-----|-----------|
| 1 | {name} | {url} | {brief relevance} |
| 2 | {name} | {url} | {brief relevance} |
```

**PHASE_4_CHECKPOINT:**

- [ ] Artifact written to `$ARTIFACTS_DIR/web-research.md`
- [ ] All sources cited with URLs
- [ ] Recommendations actionable

---

## Phase 5: OUTPUT - Report

```markdown
## Web Research Complete

**Queries**: {n} searches executed
**Sources**: {n} relevant sources found
**Artifact**: `$ARTIFACTS_DIR/web-research.md`

### Key Findings

- {Finding 1}
- {Finding 2}
- {Finding 3}

### Gaps

- {What couldn't be found, if any}
```

---

## Quality Standards

| Standard | Requirement |
|----------|-------------|
| **Accuracy** | Quote sources exactly, provide direct links |
| **Relevance** | Focus on what directly addresses the issue |
| **Currency** | Note publication dates and versions |
| **Authority** | Prioritize official docs, recognized experts |
| **Completeness** | Search multiple angles, note gaps |
| **Transparency** | Flag outdated, conflicting, or uncertain info |

---

## What NOT To Do

- Don't guess when you can search
- Don't fetch pages without checking search results first
- Don't ignore publication dates on technical content
- Don't present a single source as definitive without corroboration
- Don't skip the Gaps section — be honest about limitations

---

## Success Criteria

- **RESEARCH_EXECUTED**: At least 3 targeted searches completed
- **SOURCES_CITED**: All findings have source URLs
- **ARTIFACT_WRITTEN**: Research saved to `$ARTIFACTS_DIR/web-research.md`
- **ACTIONABLE**: Findings directly inform implementation decisions
