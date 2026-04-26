---
description: GitHub issue 또는 feature와 관련된 web source 조사
argument-hint: <issue-number or search context>
---

# Web Research

**Input**: $ARGUMENTS
**Workflow ID**: $WORKFLOW_ID

---

## 미션

Search the web for information relevant to the issue or feature being worked on. Find official documentation, known issues, best practices, and solutions that will inform implementation.

**Output**: `$ARTIFACTS_DIR/web-research.md`

**Core Principle**: Search strategically, prioritize authoritative sources, cite everything.

---

## 1단계: 파싱 — research 대상 이해

### 1.1 issue context 가져오기

If input looks like a GitHub issue number:

```bash
gh issue view $ARGUMENTS --json title,body,labels
```

### 1.2 research target 식별

From the issue context, identify:

- Key technologies, libraries, or APIs mentioned
- Error messages or stack traces to search for
- Concepts or patterns that need clarification
- Version-specific documentation needs
- Existing primitives in the ecosystem — what built-in or library-level abstractions already solve part of this? (avoids reinventing)

### 1.3 search plan 수립

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

## 2단계: 검색 — research 실행

### 2.1 llms.txt 확인

Many sites publish LLM-optimized documentation:

```
Try fetching https://{domain}/llms.txt for any known site
Read the result and fetch relevant sub-pages linked within
```

### 2.2 official documentation 검색

For each technology/library involved:

1. Search for official docs with version constraints
2. Use `site:` operator for known authoritative sources
3. Look for changelog/release notes for version info

### 2.3 known issue 검색

If the issue involves errors or bugs:

1. Search exact error messages in quotes
2. Check GitHub issues for the relevant libraries
3. Look for Stack Overflow answers

### 2.4 best practice 검색

If the issue involves implementation decisions:

1. Search for recognized patterns and approaches
2. Cross-reference multiple sources
3. Look for migration guides if changing approaches

**PHASE_2_CHECKPOINT:**

- [ ] At least 3 searches executed
- [ ] Authoritative sources found
- [ ] Relevant content extracted

---

## 3단계: 종합 — findings 정리

### 3.1 관련도별 정리

For each finding:

- **Source**: Name and URL
- **Authority**: Why this source is credible
- **Key information**: Direct quotes or specific facts
- **Applies to**: Which part of the issue this informs
- **Version/date**: Currency of the information

### 3.2 conflict/gap 식별

- Note any conflicting information between sources
- Flag outdated content
- Document what could NOT be found

**PHASE_3_CHECKPOINT:**

- [ ] Findings organized
- [ ] Conflicts noted
- [ ] Gaps documented

---

## 4단계: 생성 — artifact 작성

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

## 5단계: 출력 — 보고

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

## 품질 기준

| Standard | Requirement |
|----------|-------------|
| **Accuracy** | Quote sources exactly, provide direct links |
| **Relevance** | Focus on what directly addresses the issue |
| **Currency** | Note publication dates and versions |
| **Authority** | Prioritize official docs, recognized experts |
| **Completeness** | Search multiple angles, note gaps |
| **Transparency** | Flag outdated, conflicting, or uncertain info |

---

## 하지 말아야 할 일

- Don't guess when you can search
- Don't fetch pages without checking search results first
- Don't ignore publication dates on technical content
- Don't present a single source as definitive without corroboration
- Don't skip the Gaps section — be honest about limitations

---

## 성공 기준

- **RESEARCH_EXECUTED**: At least 3 targeted searches completed
- **SOURCES_CITED**: All findings have source URLs
- **ARTIFACT_WRITTEN**: Research saved to `$ARTIFACTS_DIR/web-research.md`
- **ACTIONABLE**: Findings directly inform implementation decisions
