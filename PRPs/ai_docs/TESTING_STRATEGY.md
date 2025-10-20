# Testing Strategy - Archon V2 Beta

## Overview

This document outlines the testing strategy for Archon V2 Beta. Given the beta status and "fail-forward" philosophy, we prioritize pragmatic testing over 100% coverage.

## Guiding Principles

1. **Impact-Focused** - Test what matters most for user experience
2. **Fast Feedback** - Tests should run quickly (<2 minutes total)
3. **No Flaky Tests** - Remove or fix unreliable tests immediately
4. **Beta Pragmatism** - Defer E2E tests until post-beta
5. **Metrics-Free** - No coverage targets, focus on value

## Backend Testing Strategy

### Priority: HIGH - Critical Business Logic

**What to Test:**
- All API routes (integration tests)
- Core service logic (crawling, embeddings, RAG)
- Database operations
- Error handling and edge cases
- Progress tracking

**Test Pattern:**
```python
@pytest.mark.asyncio
async def test_service_method(async_client):
    # Arrange
    test_data = create_test_data()

    # Act
    result = await service.method(test_data)

    # Assert
    assert result.success
    assert result.data == expected
```

**Current Coverage:**
- ✅ 49 test files
- ✅ Strong coverage of crawling, embeddings, RAG
- ⚠️ Missing tests for 9/14 API routes (being added)

### Priority: MEDIUM - Utilities and Helpers

**What to Test:**
- ETag generation
- Progress tracking
- Code extraction
- Embedding utilities

### Priority: LOW - Configuration and Setup

**What NOT to Test:**
- Simple getters/setters
- Configuration loading
- Database schema (validated at runtime)

## Frontend Testing Strategy

### Priority: HIGH - Data Fetching Layer

**What to Test:**
- TanStack Query hooks
- Query key factories
- Mutation logic
- Optimistic updates
- Error handling

**Test Pattern:**
```typescript
describe('useKnowledgeQueries', () => {
  it('fetches knowledge summaries', async () => {
    const { result } = renderHook(() => useKnowledgeSummaries(), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeDefined();
  });
});
```

**Current Coverage:**
- ✅ Excellent query hook testing
- ✅ Utility functions tested (optimistic, smart polling, ETag)
- ✅ Component tests added (KnowledgeView, ProjectsView, KnowledgeCard, TaskCard)

### Priority: MEDIUM - Component Snapshots

**What to Test:**
- Major view components (KnowledgeView, ProjectsView)
- Reusable components (KnowledgeCard, TaskCard)
- UI primitives behavior

**Test Pattern:**
```typescript
describe('KnowledgeView', () => {
  it('matches snapshot', () => {
    const { container } = render(<KnowledgeView />, {
      wrapper: createWrapper(),
    });
    expect(container).toMatchSnapshot();
  });
});
```

**Current Test Files:**
- `/archon-ui-main/src/features/knowledge/views/tests/KnowledgeView.test.tsx`
- `/archon-ui-main/src/features/projects/views/tests/ProjectsView.test.tsx`
- `/archon-ui-main/src/features/knowledge/components/tests/KnowledgeCard.test.tsx`
- `/archon-ui-main/src/features/projects/tasks/components/tests/TaskCard.test.tsx`

### Priority: LOW - E2E Testing

**Deferred to Post-Beta:**
- Full user flows
- Cross-browser testing
- Performance testing
- Visual regression testing

**Rationale:** Beta allows breaking changes, E2E tests would be brittle

## Test Organization

### Backend Tests (`python/tests/`)

```
tests/
├── server/
│   ├── api_routes/      # Integration tests for all endpoints
│   ├── services/        # Unit tests for business logic
│   └── utils/           # Utility function tests
├── mcp_server/          # MCP server tests
└── agents/              # Agent tests
```

### Frontend Tests (`archon-ui-main/src/`)

```
src/
└── features/
    └── {feature}/
        ├── hooks/
        │   └── tests/       # Query hook tests
        ├── components/
        │   └── tests/       # Component tests
        ├── views/
        │   └── tests/       # View component tests
        └── services/
            └── tests/       # Service tests
```

## Running Tests

### Backend
```bash
# All tests
uv run pytest

# Specific test file
uv run pytest tests/server/api_routes/test_projects_api.py -v

# With coverage (optional)
uv run pytest --cov=src --cov-report=html
```

### Frontend
```bash
# Watch mode (development)
npm run test

# Single run (CI)
npm run test:coverage:stream

# With UI
npm run test:ui

# Update snapshots
npm run test -- -u
```

## CI/CD Integration

### GitHub Actions Workflow

**Backend:**
- ✅ Ruff linting (continue-on-error)
- ✅ MyPy type checking (continue-on-error)
- ✅ Pytest with coverage upload

**Frontend:**
- ✅ ESLint (continue-on-error for legacy code)
- ✅ TypeScript type checking (strict)
- ✅ Vitest tests with coverage

**Docker:**
- ✅ Build verification for all services
- ✅ Health check validation

## Mock Strategy

### Backend Mocking
- Use `pytest-mock` for service dependencies
- Mock external APIs (OpenAI, Crawl4AI)
- Use in-memory database for tests when possible
- Real Supabase connection for integration tests

### Frontend Mocking
- Mock services, not query hooks
- Mock shared patterns (STALE_TIMES, DISABLED_QUERY_KEY)
- Use MSW for API mocking if needed
- Mock animation libraries (framer-motion) to avoid issues in tests
- Mock drag-and-drop (react-dnd) with proper backend wrapper

### Common Mock Patterns

**Query Hooks:**
```typescript
vi.mock("../../hooks/useKnowledgeQueries", () => ({
  useKnowledgeSummaries: vi.fn(() => ({
    data: { items: [], total: 0 },
    isLoading: false,
    error: null,
  })),
}));
```

**Shared Patterns:**
```typescript
vi.mock("../../../shared/config/queryPatterns", () => ({
  DISABLED_QUERY_KEY: ["disabled"] as const,
  STALE_TIMES: {
    instant: 0,
    realtime: 3_000,
    frequent: 5_000,
    normal: 30_000,
    rare: 300_000,
    static: Infinity,
  },
}));
```

**Animation Libraries:**
```typescript
vi.mock("framer-motion", () => ({
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  },
}));
```

## Test Maintenance

### When to Update Tests
- When changing API contracts
- When refactoring core logic
- When fixing bugs (add regression test)

### When to Remove Tests
- When removing features
- When tests become flaky
- When tests provide no value

### When to Update Snapshots
- After intentional UI changes
- After updating component props
- Run `npm run test -- -u` to update all snapshots
- Review snapshot diffs carefully before committing

### Red Flags
- 🚩 Tests take >2 minutes to run
- 🚩 Flaky tests that pass/fail randomly
- 🚩 Tests that test implementation, not behavior
- 🚩 100% coverage targets that slow development

## Snapshot Testing Best Practices

### What Makes Good Snapshots
- Capture overall component structure
- Test with realistic props
- Keep snapshots focused and minimal
- Review snapshot changes during code review

### Snapshot Test Pattern
```typescript
it("matches snapshot", () => {
  const { container } = render(<Component {...props} />, {
    wrapper: createWrapper(),
  });
  expect(container).toMatchSnapshot();
});
```

### Snapshot Maintenance
- Update snapshots after intentional changes
- Never blindly accept all snapshot changes
- Review diffs carefully - unexpected changes indicate bugs
- Commit snapshot files with source code

## Future Considerations

### Post-Beta Testing Roadmap
1. Add Playwright E2E tests for critical paths
2. Performance testing (load, stress)
3. Visual regression testing
4. Cross-browser compatibility
5. Accessibility testing

### Monitoring in Production
- Error tracking with Logfire
- Health check monitoring
- User-reported issues
- Performance metrics

## Success Metrics

Given beta status, success is measured by:
- ✅ Critical paths are tested
- ✅ Tests run fast (<2 minutes)
- ✅ No flaky tests
- ✅ High confidence in refactoring
- ✅ Easy to add new tests

**NOT measured by:**
- ❌ Code coverage percentage
- ❌ Number of tests
- ❌ Test-to-code ratio

## Component Test Examples

### View Component Test
See `/archon-ui-main/src/features/knowledge/views/tests/KnowledgeView.test.tsx` for:
- Rendering view components
- Mocking multiple hooks
- Testing button presence
- Snapshot testing

### Card Component Test
See `/archon-ui-main/src/features/knowledge/components/tests/KnowledgeCard.test.tsx` for:
- Testing with mock data
- Rendering complex components
- Testing accessibility labels
- Snapshot testing

### Drag-and-Drop Component Test
See `/archon-ui-main/src/features/projects/tasks/components/tests/TaskCard.test.tsx` for:
- Setting up DndProvider wrapper
- Testing draggable components
- Multiple wrapper composition

## Questions?

See also:
- `PRPs/ai_docs/TESTING_ANALYSIS.md` - Detailed test analysis
- `PRPs/ai_docs/ARCHITECTURE.md` - System architecture
- `CLAUDE.md` - Development guidelines
