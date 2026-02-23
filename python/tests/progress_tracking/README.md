# Progress Tracking Tests

## Why These Tests Exist

Pause/resume/cancel functionality has critical edge cases that must be tested:

1. **Operations paused before source record created** - The source_id may be NULL if pause happens during initialization
2. **Database state consistency during state transitions** - Must validate BEFORE updating status to prevent data corruption
3. **Background task lifecycle management** - Properly handle asyncio task cancellation and orchestration cleanup

These tests prevent regressions in download manager-style controls that users rely on.

## Critical Bugs Prevented

### Bug 1: Resume with Missing Source ID
**Problem**: User pauses crawl very early (during URL analysis). No source record exists yet. Resume fails because `source_id` is NULL.

**Test Coverage**:
- `test_pause_resume_cancel_api.py::test_resume_missing_source_id_returns_400`
- `test_pause_resume_flow.py::test_pause_before_source_creation_fails_on_resume`

### Bug 2: Resume Updates DB Before Validation
**Problem**: Resume endpoint updated status to "in_progress" BEFORE checking if source record exists. If validation fails, DB is left in inconsistent state.

**Fix**: Check source_id and source record BEFORE calling `ProgressTracker.resume_operation()`.

**Test Coverage**:
- `test_pause_resume_cancel_api.py::test_resume_missing_source_record_returns_404`
- All tests verify `resume_operation` is NOT called when validation fails

### Bug 3: Progress Goes Backwards After Resume
**Problem**: Resume could reset progress to 0 or earlier checkpoint value, confusing users.

**Test Coverage**:
- `test_pause_resume_flow.py::test_full_pause_resume_complete_cycle` - Verifies progress never decreases

## Test Structure

### Unit Tests (API Endpoints)

**File**: `tests/test_pause_resume_cancel_api.py`

Tests HTTP endpoints with mocked dependencies:
- Pause endpoint: `/api/knowledge-items/pause/{progress_id}`
- Resume endpoint: `/api/knowledge-items/resume/{progress_id}`
- Stop endpoint: `/api/knowledge-items/stop/{progress_id}`

**Pattern**: Mock `ProgressTracker`, `get_active_orchestration()`, and Supabase client.

### Integration Tests (Full Flow)

**File**: `tests/progress_tracking/integration/test_pause_resume_flow.py`

Tests complete lifecycle with real `ProgressTracker` and `CrawlingService`:
- Start → Pause → Resume → Complete
- Multiple pause/resume cycles
- Checkpoint data preservation
- Cancel from paused state

**Pattern**: Mock crawler and external dependencies, use real progress tracking logic.

## Running Tests Locally

### All Pause/Resume Tests
```bash
cd python
uv run pytest tests/ -k "pause or resume" -v
```

### Specific Test File
```bash
# API endpoint tests
uv run pytest tests/test_pause_resume_cancel_api.py -v

# Integration tests
uv run pytest tests/progress_tracking/integration/test_pause_resume_flow.py -v
```

### Integration Tests Only
```bash
uv run pytest tests/progress_tracking/integration/ -v
```

### With Coverage
```bash
uv run pytest tests/test_pause_resume_cancel_api.py --cov=src.server.api_routes.knowledge_api --cov-report=term-missing -v
```

### Run Specific Test
```bash
# Test the critical bug scenario
uv run pytest tests/test_pause_resume_cancel_api.py::TestResumeEndpoint::test_resume_missing_source_id_returns_400 -v
```

## Adding New Tests

When adding new pause/resume features, follow this checklist:

### 1. Add API Endpoint Test
If you modify the pause/resume/stop endpoints in `knowledge_api.py`:

1. Add test in `tests/test_pause_resume_cancel_api.py`
2. Mock `ProgressTracker` and dependencies
3. Assert correct HTTP status code and error messages
4. Verify DB operations called in correct order

**Example**:
```python
@patch("src.server.api_routes.knowledge_api.ProgressTracker")
def test_new_pause_feature(self, mock_progress_tracker, client):
    # Setup mocks
    # Make request
    # Assert response
    # Verify correct methods called
```

### 2. Add Integration Test
If you change progress tracking logic or state transitions:

1. Add test in `tests/progress_tracking/integration/test_pause_resume_flow.py`
2. Use real `ProgressTracker` instance
3. Track progress history to verify state transitions
4. Test edge cases (missing data, failed validations, etc.)

**Example**:
```python
@pytest.mark.asyncio
async def test_new_resume_feature(self):
    tracker = ProgressTracker("test-id", operation_type="crawl")
    # Simulate state changes
    # Assert state transitions valid
```

### 3. Add Frontend Component Test
If you add new UI buttons or controls:

1. Add test in `archon-ui-main/src/features/progress/components/tests/CrawlingProgress.test.tsx`
2. Mock hooks with `vi.mock()`
3. Test button visibility, click handlers, loading states

### 4. Add Frontend Hook Test
If you add new mutations or queries:

1. Add test in `archon-ui-main/src/features/knowledge/hooks/tests/useKnowledgeQueries.test.ts`
2. Use `renderHook()` from `@testing-library/react`
3. Mock service methods
4. Test success and error paths

## Common Test Patterns

### Mocking ProgressTracker
```python
@patch("src.server.api_routes.knowledge_api.ProgressTracker")
def test_example(self, mock_progress_tracker, client):
    # Mock get_progress to return operation state
    mock_progress_tracker.get_progress.return_value = {
        "progress_id": "test-123",
        "status": "paused",
        "source_id": "source-abc",
    }

    # Mock async operations
    mock_progress_tracker.pause_operation = AsyncMock(return_value=True)

    # Make request
    response = client.post("/api/knowledge-items/pause/test-123")

    # Verify
    assert response.status_code == 200
    mock_progress_tracker.pause_operation.assert_called_once_with("test-123")
```

### Mocking Supabase Client
```python
@patch("src.server.api_routes.knowledge_api.get_supabase_client")
def test_example(self, mock_get_supabase, client):
    # Create mock chain
    mock_supabase = MagicMock()
    mock_table = MagicMock()
    mock_execute = MagicMock()

    # Configure return value
    mock_execute.data = [{"source_url": "https://example.com"}]
    mock_table.select.return_value.eq.return_value.execute.return_value = mock_execute
    mock_supabase.table.return_value = mock_table
    mock_get_supabase.return_value = mock_supabase

    # Make request that queries Supabase
    # ...
```

### Testing Async Operations
```python
@pytest.mark.asyncio
async def test_async_example(self):
    tracker = ProgressTracker("test-id", operation_type="crawl")

    # Call async method
    await tracker.update(status="crawling", progress=50)

    # Assert state
    state = ProgressTracker.get_progress("test-id")
    assert state["progress"] == 50
```

### Tracking Progress History
```python
@pytest.mark.asyncio
async def test_progress_history(self, crawling_service):
    progress_history = []

    # Patch update to track calls
    original_update = crawling_service.progress_tracker.update
    async def tracked_update(*args, **kwargs):
        result = await original_update(*args, **kwargs)
        state = ProgressTracker.get_progress(progress_id)
        progress_history.append(state.copy())
        return result

    crawling_service.progress_tracker.update = tracked_update

    # Perform operations
    # ...

    # Verify history
    assert all(progress_history[i]["progress"] <= progress_history[i+1]["progress"]
               for i in range(len(progress_history) - 1))
```

## Fixtures Reference

### Backend Fixtures

**From `conftest.py`**:
- `client` - FastAPI TestClient with mocked Supabase
- `mock_supabase_client` - Mock Supabase client with chaining support
- `ensure_test_environment` - Sets test environment variables

**From `test_pause_resume_cancel_api.py`**:
- `mock_active_crawl_operation` - Active crawl in progress
- `mock_paused_operation_no_source` - Operation paused before source created (bug scenario)
- `mock_paused_operation_with_source` - Operation paused after source created (happy path)
- `mock_completed_operation` - Completed operation (cannot be paused/resumed)

**From `test_pause_resume_flow.py`**:
- `mock_crawler` - Mock Crawl4AI crawler
- `integration_mock_supabase_client` - Mock Supabase with insert/update support
- `crawling_service` - CrawlingService instance for integration tests
- `cleanup_progress_tracker` - Clears ProgressTracker state between tests

## CI/CD Integration

### Current CI Setup

Backend tests run automatically in GitHub Actions:
```yaml
- name: Run backend tests
  run: |
    cd python
    uv run pytest tests/ -v
```

New pause/resume tests are automatically discovered by pytest.

### Test Coverage Reporting

To generate coverage report:
```bash
cd python
uv run pytest --cov=src --cov-report=html tests/
open htmlcov/index.html
```

Target coverage for pause/resume/cancel code paths: **90%+**

## Debugging Failed Tests

### Common Failures

**1. Mock not called**
```
AssertionError: Expected 'pause_operation' to have been called once.
```
**Fix**: Verify mock is patched at correct import path. Use `where=` parameter in `@patch`.

**2. Async test hangs**
```
Test never completes, times out
```
**Fix**: Ensure all async operations are awaited. Check for deadlocks in mock setup.

**3. HTTPException not raised**
```
Expected HTTPException but none was raised
```
**Fix**: Verify mock configuration. Check if endpoint has try/except that swallows exception.

### Debugging Tips

1. **Print mock calls**:
   ```python
   print(mock_progress_tracker.pause_operation.call_args_list)
   ```

2. **Inspect mock configuration**:
   ```python
   print(mock_supabase.table.return_value.select.return_value)
   ```

3. **Run single test with verbose output**:
   ```bash
   uv run pytest tests/test_pause_resume_cancel_api.py::TestResumeEndpoint::test_resume_missing_source_id_returns_400 -vv -s
   ```

4. **Use pytest's `--pdb` flag** to drop into debugger on failure:
   ```bash
   uv run pytest tests/test_pause_resume_cancel_api.py --pdb
   ```

## Test Maintenance

### When to Update Tests

- **API changes**: Update endpoint tests when changing request/response format
- **Status changes**: Update tests when adding new operation statuses
- **New features**: Add tests BEFORE implementing feature (TDD)
- **Bug fixes**: Add regression test that fails, then fix bug

### Avoiding Test Rot

- Run full test suite before merging PRs
- Review test coverage monthly
- Remove tests for deprecated features
- Update mocks when dependencies change

## Performance Considerations

### Test Speed

Current test suite completion time: ~2-5 seconds

If tests become slow:
1. Reduce number of async operations
2. Mock expensive operations (DB queries, HTTP calls)
3. Use fixtures to share expensive setup
4. Run integration tests separately from unit tests

### Parallel Execution

To run tests in parallel:
```bash
uv run pytest tests/ -n auto  # Requires pytest-xdist
```

**Note**: May need to isolate ProgressTracker state to avoid conflicts.

## Future Enhancements

### Potential Additions

1. **E2E Browser Tests** (Playwright):
   - Test full user journey: click pause → see spinner → operation pauses
   - Verify toast messages appear
   - Test button state transitions

2. **Stress Tests**:
   - Rapid pause/resume cycles
   - Multiple concurrent operations
   - Memory leak detection

3. **Contract Tests**:
   - Verify frontend expectations match backend responses
   - Test API schema compatibility

4. **Property-Based Tests** (Hypothesis):
   - Generate random pause/resume sequences
   - Verify invariants (progress never decreases, status transitions valid)

These are NOT required for initial implementation but can improve robustness over time.
