# Review and Fix

Review implemented work against a PRP specification, identify issues, and automatically fix blocker/major problems before committing.

## Variables

Plan file: $ARGUMENTS (e.g., `PRPs/features/add-web-search.md`)

## Instructions

**Understand the Changes:**

- Check current branch: `git branch`
- Review changes: `git diff origin/main` (or `git diff HEAD` if not on a branch)
- Read the PRP plan file to understand requirements

**Code Quality Review:**

- **Type Safety**: Verify all functions have type annotations, mypy passes
- **Logging**: Check structured logging is used correctly (event names, context, exception handling)
- **Docstrings**: Ensure Google-style docstrings on all functions/classes
- **Testing**: Verify unit tests exist for all new files, integration tests if needed
- **Architecture**: Confirm vertical slice structure is followed
- **CLAUDE.md Compliance**: Check adherence to core principles (KISS, YAGNI, TYPE SAFETY)

**Validation Ruff for BE and Biome for FE:**

- Run linters: `uv run ruff check src/ && uv run mypy src/`
- Run tests: `uv run pytest tests/ -v`
- Start server and test endpoints with curl (if applicable)
- Verify structured logs show proper correlation IDs and context

**Issue Severity:**

- `blocker` - Must fix before merge (breaks build, missing tests, type errors, security issues)
- `major` - Should fix (missing logging, incomplete docstrings, poor patterns)
- `minor` - Nice to have (style improvements, optimization opportunities)

## Report

Return ONLY valid JSON (no markdown, no explanations) save to [report-#.json] in prps/reports directory create the directory if it doesn't exist. Output will be parsed with JSON.parse().

### Output Structure

```json
{
  "success": "boolean - true if NO BLOCKER issues, false if BLOCKER issues exist",
  "review_summary": "string - 2-4 sentences: what was built, does it match spec, quality assessment",
  "review_issues": [
    {
      "issue_number": "number - issue index",
      "file_path": "string - file with the issue (if applicable)",
      "issue_description": "string - what's wrong",
      "issue_resolution": "string - how to fix it",
      "severity": "string - blocker|major|minor"
    }
  ],
  "validation_results": {
    "linting_passed": "boolean",
    "type_checking_passed": "boolean",
    "tests_passed": "boolean",
    "api_endpoints_tested": "boolean - true if endpoints were tested with curl"
  }
}
```

## Example Success Review

```json
{
  "success": true,
  "review_summary": "The web search tool has been implemented with proper type annotations, structured logging, and comprehensive tests. The implementation follows the vertical slice architecture and matches all spec requirements. Code quality is high with proper error handling and documentation.",
  "review_issues": [
    {
      "issue_number": 1,
      "file_path": "src/tools/web_search/tool.py",
      "issue_description": "Missing debug log for API response",
      "issue_resolution": "Add logger.debug with response metadata",
      "severity": "minor"
    }
  ],
  "validation_results": {
    "linting_passed": true,
    "type_checking_passed": true,
    "tests_passed": true,
    "api_endpoints_tested": true
  }
}
```

## Fix Issues

After generating the review report, automatically fix blocker and major issues:

**Parse the Report:**
- Read the generated `PRPs/reports/report-#.json` file
- Extract all issues with severity "blocker" or "major"

**Apply Fixes:**

For each blocker/major issue:
1. Read the file mentioned in `file_path`
2. Apply the fix described in `issue_resolution`
3. Log what was fixed

**Re-validate:**
- Rerun linters: `uv run ruff check src/ --fix`
- Rerun type checker: `uv run mypy src/`
- Rerun tests: `uv run pytest tests/ -v`

**Report Results:**
- If all blockers fixed and validation passes → Output "✅ All critical issues fixed, validation passing"
- If fixes failed or validation still failing → Output "⚠️ Some issues remain" with details
- Minor issues can be left for manual review later

**Important:**
- Only fix blocker/major issues automatically
- Minor issues should be left in the report for human review
- If a fix might break something, skip it and note in output
- Run validation after ALL fixes applied, not after each individual fix
