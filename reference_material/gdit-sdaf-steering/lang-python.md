---
inclusion: always
enforcement: mandatory
---

# Python Language Standards

Reference examples: `~/.kiro/steering/lang-python-reference.md`

## Context

This steering file defines Python-specific development standards including version requirements, validation tooling, naming conventions, security patterns, and project structure. It is loaded by Python-focused GDIT-SDAF agent variants.

## Version & Tooling

- **Version**: Python 3.12 or greater
- **PEP 723 Compliance**: Use inline script metadata with dependency descriptors
- **Compliance Constraint**: Inline descriptors permitted only if they do not trigger compliance scanning findings (gitleaks, semgrep, checkov)

**project.yaml overrides** (optional — defaults above apply when absent):

- `language.python.min-version` — override minimum Python version
- `language.python.linter` — override linter (default: ruff)
- `language.python.type-checker` — override type checker (default: pyright)

## Manual Validation Tools

Since hooks don't trigger in kiro-cli, you MUST manually run these for Python code files (\*.py):

> **Note**: The tools below document defaults. Runtime scanner selection is driven by `security.scanner-file-mapping` in `project.yaml` when present. See `project-yaml-expansion` spec for the central mapping schema.

```bash
# Syntax validation
python -m py_compile <file>

# Linting (auto-fixable)
ruff check <file>

# Type checking and static analysis
pyright <file>

# SAST scanning
semgrep --config=auto --severity=ERROR --severity=WARNING --json <file>

# Secrets detection
gitleaks detect --source <file> --no-git --verbose

# Vulnerability scanning
trivy fs --scanners vuln --severity HIGH,CRITICAL <directory>
```

**Blocking Criteria:**

- BLOCK on: Secrets detected, ERROR-level SAST, HIGH/CRITICAL vulnerabilities, syntax errors, pyright errors
- ADVISORY on: WARNING-level findings, MEDIUM vulnerabilities, naming violations, ruff lint findings (auto-fix with `ruff check --fix`), pyright warnings
- ADVISORY on: WARNING-level findings, MEDIUM vulnerabilities, naming violations

## Naming Conventions

### Functions and Methods

- **Format**: snake_case
- **Examples**: `get_user_data`, `validate_input`, `process_sqs_message`

### Variables

- **Format**: snake_case
- **Examples**: `user_id`, `item_data`, `retry_count`

### Constants

- **Format**: UPPER_SNAKE_CASE
- **Examples**: `MAX_RETRY_ATTEMPTS`, `DEFAULT_TIMEOUT`, `TABLE_NAME`

### Classes

- **Format**: PascalCase
- **Examples**: `DataValidator`, `UserManager`, `EventProcessor`

### Lambda Handler Files

- **Format**: snake_case matching function name
- **Examples**: `security_hub_publisher.py`, `lifecycle_automation.py`

## Project Structure

### Lambda Source Code

- `src/lambdas/[function-name]/[function_name].py`
- `src/lambdas-internal/[service-name]/[function-name]/[function_name].py`

### Lambda Layers

- `src/layers/[layer-name]/python/[module_name].py`

### Tests

- `tests/unit/test_[module_name].py`
- `tests/integration/test_[feature_name].py`

### Dependencies

- `requirements.txt` at project root or per-Lambda directory
- Use virtual environments (`venv/`) for local development

## Security Patterns (Summary)

- **Lambda events**: Sanitize all event payloads (validate path params, parse body as JSON, allowlist headers)
- **Secrets**: Use AWS Secrets Manager via `boto3`, reference via environment variables, never hardcode
- **Database queries**: Use parameterized queries (DynamoDB Key expressions, SQL `%s` placeholders)
- **Error handling**: Return generic messages to clients, log details internally, include security headers
- **Anti-patterns**: No unvalidated input, no string-concatenated queries, no hardcoded credentials, no leaked stack traces

## Testing Conventions

Testing conventions are applied when `workflow.testing` is `test-after` or `test-driven` in `project.yaml`.

### pytest (default for Python)

- Test directory: `tests/` at project root
- Test file naming: `test_{module}.py`
- One test file per spec feature, one test function per acceptance criterion
- Use `assert` directly, not `self.assertEqual`
- Shared fixtures in `conftest.py` at test directory root
- Parametrize repetitive assertions with `@pytest.mark.parametrize`
- Run command: `pytest tests/ -v`

### unittest

- Test directory: `tests/` at project root
- Test file naming: `test_{module}.py`
- One test file per spec feature, one test class per feature, one method per acceptance criterion
- Test classes extend `unittest.TestCase`
- Setup/teardown via `setUp()`/`tearDown()` methods
- Run command: `python -m unittest discover tests/`

### Test-to-Spec Mapping

```
requirements.md acceptance criterion  →  one test function
design.md correctness property        →  one test function
.kiro/specs/user-greeting/            →  tests/test_user_greeting.py
```

### Test Markers (when layers configured)

Tag every test with its layer using pytest markers:

```python
import pytest

@pytest.mark.unit
def test_greet_with_name():
    assert greet("Alice") == "Hello, Alice!"

@pytest.mark.integration
def test_greet_writes_to_log(tmp_path):
    greet("Alice", log_dir=tmp_path)
    assert (tmp_path / "greet.log").exists()

@pytest.mark.e2e
def test_greeting_page(page):
    page.goto("/greet?name=Alice")
    assert page.text_content("h1") == "Hello, Alice!"

@pytest.mark.pipeline
def test_api_returns_200(api_endpoint):
    """Pipeline test — requires deployed stack. Uses conftest.py fixture."""
    if api_endpoint:
        import urllib.request
        resp = urllib.request.urlopen(api_endpoint)
        assert resp.status == 200
```

### Selective Execution

```bash
pytest tests/ -v                          # all tests
pytest tests/unit/ -v                     # by directory
pytest tests/ -m unit -v                  # by marker
pytest tests/ -k "user_greeting" -v       # by feature/spec name
pytest tests/unit/test_user_greeting.py   # single file
pytest tests/pipeline/ -v -m pipeline     # pipeline tests only (requires deployed stack)
```

### Runner Config (generated on first test if missing)

```toml
# pyproject.toml
[tool.pytest.ini_options]
testpaths = ["tests"]
markers = [
    "unit: Unit tests derived from design.md correctness properties",
    "integration: Integration tests for cross-module interactions",
    "e2e: End-to-end tests derived from requirements.md acceptance criteria",
    "pipeline: Pipeline-executable tests requiring deployed infrastructure",
]
addopts = "-v --tb=short"
```

### Pipeline Test Fixtures (tests/pipeline/conftest.py)

Pipeline tests use a `conftest.py` that reads stack outputs from the deploy action artifact or environment variables. Tests must never hardcode endpoints or resource names.

```python
import json, os
import pytest

@pytest.fixture(scope="session")
def stack_outputs():
    outputs_dir = os.environ.get("CODEBUILD_SRC_DIR_DeployOutputs", "")
    outputs_file = (
        os.path.join(outputs_dir, "stack-outputs.json") if outputs_dir
        else os.environ.get("STACK_OUTPUTS_FILE", "")
    )
    if outputs_file and os.path.exists(outputs_file):
        with open(outputs_file) as f:
            raw = json.load(f)
        return {o["OutputKey"]: o["OutputValue"] for o in raw.get("Stacks", [{}])[0].get("Outputs", [])}
    return {}
```

### Test Dependencies (requirements-test.txt)

Pipeline test dependencies are listed in `requirements-test.txt` at the project root, separate from application `requirements.txt`. The CodeBuild test runner installs from this file during the install phase.

### Playwright (E2E — Python)

- Test directory: `tests/e2e/` at project root
- Test file naming: `test_{feature}.py`
- One test file per spec feature, one test function per user-facing acceptance criterion
- Uses `pytest-playwright` with `page` fixture
- Run command: `pytest tests/e2e/ -v`

### Playwright (E2E — JavaScript/TypeScript)

- Test directory: `tests/e2e/`
- Test file naming: `{feature}.spec.ts`
- `test.describe` blocks with `test()` functions
- One file per spec, one test per user-facing acceptance criterion
- Run command: `npx playwright test`

### Cypress (E2E)

- Test directory: `cypress/e2e/`
- Test file naming: `{feature}.cy.ts`
- `describe` blocks with `it()` functions
- One file per spec, one test per user-facing acceptance criterion
- Run command: `npx cypress run`
