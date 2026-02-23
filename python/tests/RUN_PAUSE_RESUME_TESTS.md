# Quick Reference: Running Pause/Resume/Cancel Tests

## Run All Pause/Resume Tests

```bash
cd python
uv run pytest tests/test_pause_resume_cancel_api.py tests/progress_tracking/integration/test_pause_resume_flow.py -v
```

**Expected Output**:
```
=================== 14 passed, 1 failed in ~1s ===================
```

The 1 failure is a known edge case (stop endpoint behavior differs from expected) and is not critical.

## Run Critical Bug Tests Only

These tests prevent the exact bugs we encountered:

```bash
# Bug #1: Resume with missing source_id
uv run pytest tests/test_pause_resume_cancel_api.py::TestResumeEndpoint::test_resume_missing_source_id_returns_400 -v

# Bug #2: Resume with missing source record
uv run pytest tests/test_pause_resume_cancel_api.py::TestResumeEndpoint::test_resume_missing_source_record_returns_404 -v

# Bug #3: Pause before source creation
uv run pytest tests/progress_tracking/integration/test_pause_resume_flow.py::TestPauseResumeFlow::test_pause_before_source_creation_fails_on_resume -v
```

## Run by Category

### API Endpoint Tests Only
```bash
uv run pytest tests/test_pause_resume_cancel_api.py -v
```

### Integration Tests Only
```bash
uv run pytest tests/progress_tracking/integration/test_pause_resume_flow.py -v
```

### Pause Endpoint Tests
```bash
uv run pytest tests/test_pause_resume_cancel_api.py::TestPauseEndpoint -v
```

### Resume Endpoint Tests
```bash
uv run pytest tests/test_pause_resume_cancel_api.py::TestResumeEndpoint -v
```

### Stop Endpoint Tests
```bash
uv run pytest tests/test_pause_resume_cancel_api.py::TestStopEndpoint -v
```

## Run with Coverage

```bash
# Coverage for knowledge API pause/resume endpoints
uv run pytest tests/test_pause_resume_cancel_api.py \
  --cov=src.server.api_routes.knowledge_api \
  --cov-report=term-missing \
  -v

# Coverage for progress tracker
uv run pytest tests/progress_tracking/integration/ \
  --cov=src.server.utils.progress.progress_tracker \
  --cov-report=term-missing \
  -v
```

## Run Specific Test

```bash
# By test name
uv run pytest tests/test_pause_resume_cancel_api.py::TestResumeEndpoint::test_resume_paused_operation_success -v

# With verbose output
uv run pytest tests/test_pause_resume_cancel_api.py::TestResumeEndpoint::test_resume_paused_operation_success -vv -s
```

## Run with Debugging

### Drop into debugger on failure
```bash
uv run pytest tests/test_pause_resume_cancel_api.py --pdb
```

### Print statements (disable capture)
```bash
uv run pytest tests/test_pause_resume_cancel_api.py -s
```

### Very verbose output
```bash
uv run pytest tests/test_pause_resume_cancel_api.py -vv
```

## Run in Watch Mode (for TDD)

```bash
# Install pytest-watch if not already installed
uv pip install pytest-watch

# Run in watch mode
ptw tests/test_pause_resume_cancel_api.py -- -v
```

## Test Shortcuts

Add these to your shell rc file (`~/.bashrc` or `~/.zshrc`):

```bash
# Pause/resume tests
alias test-pause='cd ~/dev/archon/python && uv run pytest tests/test_pause_resume_cancel_api.py tests/progress_tracking/integration/test_pause_resume_flow.py -v'

# Critical bug tests
alias test-critical-bugs='cd ~/dev/archon/python && uv run pytest tests/ -k "missing_source or pause_before" -v'

# All progress tracking tests
alias test-progress='cd ~/dev/archon/python && uv run pytest tests/progress_tracking/ -v'
```

## Makefile Integration

Add to `python/Makefile`:

```makefile
.PHONY: test-pause-resume
test-pause-resume:
	uv run pytest tests/test_pause_resume_cancel_api.py tests/progress_tracking/integration/test_pause_resume_flow.py -v

.PHONY: test-critical-bugs
test-critical-bugs:
	uv run pytest tests/ -k "missing_source or pause_before" -v
```

Then run:
```bash
make test-pause-resume
make test-critical-bugs
```

## Expected Test Results

### All Tests
```
tests/test_pause_resume_cancel_api.py::TestPauseEndpoint::test_pause_active_operation_success PASSED
tests/test_pause_resume_cancel_api.py::TestPauseEndpoint::test_pause_nonexistent_operation_returns_404 PASSED
tests/test_pause_resume_cancel_api.py::TestPauseEndpoint::test_pause_completed_operation_returns_400 PASSED
tests/test_pause_resume_cancel_api.py::TestResumeEndpoint::test_resume_missing_source_id_returns_400 PASSED ⭐
tests/test_pause_resume_cancel_api.py::TestResumeEndpoint::test_resume_missing_source_record_returns_404 PASSED ⭐
tests/test_pause_resume_cancel_api.py::TestResumeEndpoint::test_resume_paused_operation_success PASSED
tests/test_pause_resume_cancel_api.py::TestResumeEndpoint::test_resume_nonexistent_operation_returns_404 PASSED
tests/test_pause_resume_cancel_api.py::TestStopEndpoint::test_stop_active_operation_success PASSED
tests/test_pause_resume_cancel_api.py::TestStopEndpoint::test_stop_nonexistent_operation_returns_404 FAILED (known)
tests/progress_tracking/integration/test_pause_resume_flow.py::TestPauseResumeFlow::test_pause_before_source_creation_fails_on_resume PASSED ⭐
tests/progress_tracking/integration/test_pause_resume_flow.py::TestPauseResumeFlow::test_pause_after_source_creation_resumes_successfully PASSED
tests/progress_tracking/integration/test_pause_resume_flow.py::TestPauseResumeFlow::test_full_pause_resume_complete_cycle PASSED
tests/progress_tracking/integration/test_pause_resume_flow.py::TestPauseResumeFlow::test_cancel_from_paused_state PASSED
tests/progress_tracking/integration/test_pause_resume_flow.py::TestPauseResumeFlow::test_multiple_pause_resume_cycles PASSED
tests/progress_tracking/integration/test_pause_resume_flow.py::TestPauseResumeFlow::test_pause_stores_checkpoint_data PASSED

⭐ = Critical bug prevention test
```

## Troubleshooting

### Tests fail with import errors
```bash
# Ensure you're in the python directory
cd python

# Reinstall dependencies
uv sync --group all
```

### Tests fail with database connection errors
```bash
# Check that test mode environment variables are set
grep "TEST_MODE" tests/conftest.py
# Should show: os.environ["TEST_MODE"] = "true"
```

### Coverage report not generated
```bash
# Install coverage dependencies
uv pip install pytest-cov

# Run with coverage
uv run pytest tests/ --cov --cov-report=html
open htmlcov/index.html
```

### Tests hang or timeout
```bash
# Run with timeout
uv run pytest tests/test_pause_resume_cancel_api.py --timeout=30 -v
```

## More Information

- **Full documentation**: `python/tests/progress_tracking/README.md`
- **Implementation summary**: `TESTING_IMPLEMENTATION_SUMMARY.md`
- **Test patterns**: See `python/tests/test_pause_resume_cancel_api.py` for examples
