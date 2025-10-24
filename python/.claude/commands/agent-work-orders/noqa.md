# NOQA Analysis and Resolution

Find all noqa/type:ignore comments in the codebase, investigate why they exist, and provide recommendations for resolution or justification.

## Instructions

**Step 1: Find all NOQA comments**

- Use Grep tool to find all noqa comments: pattern `noqa|type:\s*ignore`
- Use output_mode "content" with line numbers (-n flag)
- Search across all Python files (type: "py")
- Document total count of noqa comments found

**Step 2: For EACH noqa comment (repeat this process):**

- Read the file containing the noqa comment with sufficient context (at least 10 lines before and after)
- Identify the specific linting rule or type error being suppressed
- Understand the code's purpose and why the suppression was added
- Investigate if the suppression is still necessary or can be resolved

**Step 3: Investigation checklist for each noqa:**

- What specific error/warning is being suppressed? (e.g., `type: ignore[arg-type]`, `noqa: F401`)
- Why was the suppression necessary? (legacy code, false positive, legitimate limitation, technical debt)
- Can the underlying issue be fixed? (refactor code, update types, improve imports)
- What would it take to remove the suppression? (effort estimate, breaking changes, architectural changes)
- Is the suppression justified long-term? (external library limitation, Python limitation, intentional design)

**Step 4: Research solutions:**

- Check if newer versions of tools (mypy, ruff) handle the case better
- Look for alternative code patterns that avoid the suppression
- Consider if type stubs or Protocol definitions could help
- Evaluate if refactoring would be worthwhile

## Report Format

Create a markdown report file (create the reports directory if not created yet): `PRPs/reports/noqa-analysis-{YYYY-MM-DD}.md`

Use this structure for the report:

````markdown
# NOQA Analysis Report

**Generated:** {date}
**Total NOQA comments found:** {count}

---

## Summary

- Total suppressions: {count}
- Can be removed: {count}
- Should remain: {count}
- Requires investigation: {count}

---

## Detailed Analysis

### 1. {File path}:{line number}

**Location:** `{file_path}:{line_number}`

**Suppression:** `{noqa comment or type: ignore}`

**Code context:**

```python
{relevant code snippet}
```
````

**Why it exists:**
{explanation of why the suppression was added}

**Options to resolve:**

1. {Option 1: description}
   - Effort: {Low/Medium/High}
   - Breaking: {Yes/No}
   - Impact: {description}

2. {Option 2: description}
   - Effort: {Low/Medium/High}
   - Breaking: {Yes/No}
   - Impact: {description}

**Tradeoffs:**

- {Tradeoff 1}
- {Tradeoff 2}

**Recommendation:** {Remove | Keep | Refactor}
{Justification for recommendation}

---

{Repeat for each noqa comment}

````

## Example Analysis Entry

```markdown
### 1. src/shared/config.py:45

**Location:** `src/shared/config.py:45`

**Suppression:** `# type: ignore[assignment]`

**Code context:**
```python
@property
def openai_api_key(self) -> str:
    key = os.getenv("OPENAI_API_KEY")
    if not key:
        raise ValueError("OPENAI_API_KEY not set")
    return key  # type: ignore[assignment]
````

**Why it exists:**
MyPy cannot infer that the ValueError prevents None from being returned, so it thinks the return type could be `str | None`.

**Options to resolve:**

1. Use assert to help mypy narrow the type
   - Effort: Low
   - Breaking: No
   - Impact: Cleaner code, removes suppression

2. Add explicit cast with typing.cast()
   - Effort: Low
   - Breaking: No
   - Impact: More verbose but type-safe

3. Refactor to use separate validation method
   - Effort: Medium
   - Breaking: No
   - Impact: Better separation of concerns

**Tradeoffs:**

- Option 1 (assert) is cleanest but asserts can be disabled with -O flag
- Option 2 (cast) is most explicit but adds import and verbosity
- Option 3 is most robust but requires more refactoring

**Recommendation:** Remove (use Option 1)
Replace the type:ignore with an assert statement after the if check. This helps mypy understand the control flow while maintaining runtime safety. The assert will never fail in practice since the ValueError is raised first.

**Implementation:**

```python
@property
def openai_api_key(self) -> str:
    key = os.getenv("OPENAI_API_KEY")
    if not key:
        raise ValueError("OPENAI_API_KEY not set")
    assert key is not None  # Help mypy understand control flow
    return key
```

```

## Report

After completing the analysis:

- Output the path to the generated report file
- Summarize findings:
  - Total suppressions found
  - How many can be removed immediately (low effort)
  - How many should remain (justified)
  - How many need deeper investigation or refactoring
- Highlight any quick wins (suppressions that can be removed with minimal effort)
```
