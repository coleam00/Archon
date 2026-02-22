# Prompt Regression Tests

This directory contains regression tests for AI prompts used throughout Archon.

## Purpose

These tests ensure that:
1. **Prompts produce expected output structure** - JSON schemas remain consistent
2. **Changes don't break parsing** - Output is still machine-readable
3. **Quality baselines are maintained** - Summaries/outputs meet minimum standards
4. **Different models work correctly** - Tests can be run against various LLM providers

## Tests

### `test_code_summary_prompt.py`

Tests the code summarization prompt used during knowledge base indexing.

**What it tests**:
- Code summary generation for various programming languages
- JSON output structure validation
- Structured format adherence (PURPOSE/PARAMETERS/USE WHEN)
- Cross-provider compatibility

**Location in codebase**: `src/server/services/storage/code_storage_service.py` (lines 631-643)

**Run it**:
```bash
# From python/ directory
uv run python tests/prompts/test_code_summary_prompt.py

# Or with pytest
uv run pytest tests/prompts/test_code_summary_prompt.py -v

# Test specific provider
uv run python tests/prompts/test_code_summary_prompt.py ollama
```

**Output**: Generates `code_summary_test_results.json` with detailed results for inspection.

## When to Run

### Required
- **Before merging prompt changes** - Ensure output structure remains compatible
- **When updating LLM dependencies** - Verify new model versions work correctly
- **During provider migrations** - Test that new providers produce valid output

### Recommended
- **In CI/CD pipeline** - Automated regression testing on every PR
- **After credential/settings changes** - Verify configuration is correct
- **When debugging summary quality issues** - Baseline for comparison

## Adding New Prompt Tests

When adding a new prompt that's used in production:

1. **Create test file**: `test_<feature>_prompt.py`
2. **Include sample inputs**: Diverse, realistic examples
3. **Validate output structure**: Assert on expected JSON schema
4. **Check quality indicators**: Verify output meets minimum standards
5. **Export results**: Generate JSON artifact for debugging
6. **Document the prompt**: Add entry to `PRPs/ai_docs/CODE_SUMMARY_PROMPT.md` or create new doc

### Template

```python
#!/usr/bin/env python3
"""Test for <feature> prompt."""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "src"))

from server.services.<module> import <function>

# Sample inputs
SAMPLES = [...]

async def test_single_sample(sample):
    result = await <function>(sample)

    # Validate structure
    assert 'required_field' in result
    assert len(result['required_field']) > 0

    return result

async def main():
    results = []
    for sample in SAMPLES:
        result = await test_single_sample(sample)
        results.append(result)

    # Export results
    output_file = Path(__file__).parent / "<feature>_test_results.json"
    # ...

if __name__ == "__main__":
    asyncio.run(main())
```

## Documentation

Full documentation for the code summary prompt test:
- **`PRPs/ai_docs/CODE_SUMMARY_PROMPT.md`** - Implementation details, benchmarks, troubleshooting

## Integration with pytest

These tests can be run with pytest, but they're also designed as standalone scripts for manual testing and debugging. The dual nature allows:
- **CI/CD automation** via pytest
- **Manual exploration** via direct execution with custom parameters

---

**Maintainer Note**: Keep these tests updated whenever prompt changes are made. They're not just validation — they're documentation of expected behavior and examples for future developers.
