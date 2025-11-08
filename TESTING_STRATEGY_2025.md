# Archon Testing Strategy 2025

**Report Date:** 2025-11-08
**Current State:** Beta phase, local-only deployment
**Testing Philosophy:** Testing Trophy approach (focus on integration tests)

---

## Executive Summary

This report analyzes Archon's current testing infrastructure against 2025 industry best practices and provides actionable recommendations. The current testing foundation is solid with modern tooling (Vitest, Pytest), but significant gaps exist in coverage, integration testing, and E2E testing that should be addressed strategically based on priority and ROI.

**Key Metrics:**
- Backend Test Coverage: ~60%
- Frontend Test Coverage: ~25%
- Total Test Files: 91 (77 Python, 14 TypeScript)
- E2E Tests: None
- Performance Tests: None
- Visual Regression Tests: None

---

## 1. Current Testing Strengths

### Backend Testing (Python)

#### ✅ Modern Framework Setup
- **pytest-asyncio** with auto mode configured (`asyncio_mode = auto`)
- Proper async test support for FastAPI endpoints
- 77 test files with good organization

#### ✅ Well-Structured Test Configuration
```ini
# /home/user/Smart-Founds-Grant/python/pytest.ini
- asyncio_default_fixture_loop_scope = function
- asyncio_default_test_loop_scope = function
- Markers: unit, integration, slow, asyncio
```

#### ✅ Comprehensive Mocking Strategy
- Global mocking of Supabase client in conftest.py
- Proper test isolation preventing real DB calls
- Reusable fixtures (`mock_supabase_client`, `test_project`, `test_task`)

#### ✅ Good Test Patterns
- AAA pattern (Arrange, Act, Assert) consistently followed
- AsyncMock for async operations
- Proper fixture scoping
- Example from `/home/user/Smart-Founds-Grant/python/tests/server/services/test_version_service.py`:
  - Cache behavior testing
  - Error handling (404, timeout)
  - Version comparison logic

#### ✅ Service Layer Coverage
- API routes testing (`test_api_essentials.py`)
- Service layer testing (version_service, migration_service)
- MCP tools testing
- Progress tracking testing

### Frontend Testing (TypeScript)

#### ✅ Modern Vitest Setup
```typescript
// /home/user/Smart-Founds-Grant/archon-ui-main/vitest.config.ts
- jsdom environment for React testing
- v8 coverage provider
- 10s test timeout
- Colocated tests in features
```

#### ✅ Query Hook Testing Patterns
- Proper TanStack Query testing with QueryClient wrapper
- Mock services and patterns
- Optimistic update testing
- Example from `/home/user/Smart-Founds-Grant/archon-ui-main/src/features/projects/hooks/tests/useProjectQueries.test.ts`:
  - Query key factory testing
  - Mutation rollback testing
  - Cache behavior verification

#### ✅ Integration Test Foundation
- Basic integration tests in `/home/user/Smart-Founds-Grant/archon-ui-main/tests/integration/`
- Real API endpoint testing (skipped in CI)
- Cleanup logic in afterAll hooks

#### ✅ Testing Infrastructure
- React Testing Library for component testing
- User event simulation support
- Coverage reporting (text, HTML, JSON, LCOV)

---

## 2. Testing Gaps to Address

### Critical Gaps (P0 - Address Immediately)

#### 🔴 Low Frontend Coverage (25%)
**Impact:** High risk of UI regressions
**Current State:**
- Only 14 test files for entire frontend
- Major features untested:
  - Knowledge base components (partial coverage)
  - MCP integration UI (no tests)
  - Settings panels (no tests)
  - Project views (minimal coverage)

**Recommendation:** Increase to 60% within 2 months
**Target Files:**
- Component tests for all features in `/home/user/Smart-Founds-Grant/archon-ui-main/src/features/`
- Service layer tests (API calls)
- Shared utilities and hooks

#### 🔴 No E2E Tests
**Impact:** Critical user flows untested end-to-end
**Current State:**
- Playwright installed (dependency detected) but no tests
- No critical path validation:
  - Crawl workflow (start → progress → complete)
  - Project creation → task management
  - Knowledge search and retrieval
  - Settings configuration

**Recommendation:** Implement within 1 month
**Priority Flows:**
1. Knowledge crawling (highest value)
2. Project and task management
3. RAG search functionality
4. Settings and provider configuration

### High Priority Gaps (P1 - Address within Quarter)

#### 🟡 Missing Contract Testing
**Impact:** API breaking changes not caught early
**Current State:**
- No contract testing between frontend and backend
- Manual API coordination required
- Risk of silent failures when API changes

**Recommendation:** Implement Pact or OpenAPI-based contract testing
**Benefits:**
- Consumer-driven contracts
- Early detection of breaking changes
- Better API documentation
- CI/CD integration

#### 🟡 No Performance Testing
**Impact:** Unknown system limits and scalability issues
**Current State:**
- No load testing infrastructure
- No performance benchmarks
- Unknown crawling capacity limits
- RAG search performance not measured

**Recommendation:** Add k6 for performance testing
**Target Scenarios:**
- Concurrent crawl operations
- RAG search under load
- Project/task bulk operations
- WebSocket connection limits (if added)

#### 🟡 Missing Visual Regression Testing
**Impact:** UI changes may break unexpectedly
**Current State:**
- No screenshot comparison
- No component visual regression
- Glassmorphism UI complex to validate manually

**Recommendation:** Add Chromatic or Percy
**Justification:**
- Design system (Radix UI + custom styling)
- Tron-inspired glassmorphism
- Component library growth

### Medium Priority Gaps (P2 - Address as Capacity Allows)

#### 🟢 Limited Integration Test Coverage
**Current State:**
- 2 integration test files
- Tests skip in CI (`describe.skip`)
- No database integration tests

**Recommendation:** Expand integration tests
**Areas:**
- Service integration (knowledge_service + database)
- Progress tracking integration
- MCP tool integration
- Agent service integration

#### 🟢 Test Data Management
**Current State:**
- Fixtures in conftest.py (basic)
- No factory pattern usage
- No test data builders

**Recommendation:** Implement factory-boy patterns
**Benefits:**
- Reusable test data builders
- Reduced test maintenance
- Better test readability

#### 🟢 Code Quality Metrics
**Current State:**
- Coverage thresholds not enforced
- No mutation testing
- No test quality metrics

**Recommendation:** Add coverage gates
**Targets:**
- Backend: 70% statement coverage
- Frontend: 60% statement coverage
- Critical paths: 90% coverage

---

## 3. Recommended Testing Strategy

### Testing Trophy Approach (Kent C. Dodds 2025)

Archon should follow the Testing Trophy model, which prioritizes:

```
           /\     E2E (Narrow layer - critical paths)
          /  \
         /----\   Integration (LARGEST - highest ROI)
        /      \
       /--------\ Unit (Smaller - fast feedback)
      /==========\ Static (Foundation - linters, TypeScript)
```

**Rationale:**
- Integration tests provide best ROI for web applications
- Catch more bugs than unit tests
- Less brittle than E2E tests
- Align with Archon's vertical slice architecture

### Layer-by-Layer Strategy

#### Static Analysis (Foundation) ✅
**Current:** Strong foundation
- TypeScript strict mode
- Biome for features directory
- ESLint for legacy code
- Ruff + MyPy for Python

**Keep:** No changes needed

#### Unit Tests (Fast Feedback)
**Current:** 60% backend, 25% frontend
**Target:** 60% backend, 50% frontend

**Focus Areas:**
- Pure functions and utilities
- Service methods (isolated)
- Query hooks
- API client
- Shared utilities

**Pattern:**
```typescript
// Example: Query hook unit test
describe('useProjects', () => {
  it('should fetch projects list', async () => {
    // Arrange: Mock service
    vi.mocked(projectService.listProjects).mockResolvedValue(mockProjects);

    // Act: Render hook
    const { result } = renderHook(() => useProjects(), { wrapper });

    // Assert: Verify behavior
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
});
```

#### Integration Tests (Highest Priority) 🎯
**Current:** Minimal (2 files, skipped in CI)
**Target:** Comprehensive coverage of critical paths

**Focus Areas:**
1. **Backend Service Integration:**
   - Knowledge service + database
   - Progress tracking + websockets (if added)
   - MCP tools + Supabase
   - Agent service + external APIs

2. **Frontend Component Integration:**
   - Feature flows (projects → tasks → documents)
   - Query patterns + API client
   - Optimistic updates + cache management

3. **API Integration:**
   - Contract tests (Pact)
   - Request/response validation
   - Error handling

**Pattern:**
```python
# Example: Backend integration test
@pytest.mark.integration
async def test_knowledge_crawl_full_flow(test_db):
    """Test complete crawl workflow with real database."""
    # Arrange: Create source
    source = await knowledge_service.create_source(url="https://example.com")

    # Act: Start crawl and wait
    progress_id = await knowledge_service.start_crawl(source.id)
    await wait_for_completion(progress_id, timeout=30)

    # Assert: Verify results
    documents = await knowledge_service.get_documents(source.id)
    assert len(documents) > 0
    assert all(doc.embedding is not None for doc in documents)
```

#### E2E Tests (Critical Paths Only)
**Current:** None
**Target:** 10-15 critical user journeys

**Tool:** Playwright (already installed)

**Priority Flows:**
1. **Knowledge Base:**
   - Start crawl → monitor progress → view results → search
   - Upload document → process → search

2. **Project Management:**
   - Create project → add tasks → update status → view progress

3. **RAG Search:**
   - Perform search → view results → expand details

4. **Settings:**
   - Configure provider → test connection → save

**Pattern:**
```typescript
// Example: E2E test with Playwright
test('crawl website end-to-end', async ({ page }) => {
  // Navigate to knowledge page
  await page.goto('/knowledge');

  // Start crawl
  await page.click('[data-testid="new-crawl-button"]');
  await page.fill('[data-testid="url-input"]', 'https://example.com');
  await page.click('[data-testid="start-crawl"]');

  // Wait for progress
  await expect(page.locator('[data-testid="crawl-status"]')).toContainText('completed');

  // Verify results
  await expect(page.locator('[data-testid="document-list"]')).toBeVisible();
});
```

---

## 4. Tools to Add

### Immediate (Q1 2025)

#### 1. Playwright for E2E Testing
**Status:** Dependency installed, no tests written
**Location:** `/home/user/Smart-Founds-Grant/python/.venv/lib/python3.13/site-packages/playwright`

**Setup Required:**
```bash
# Install Playwright browsers
cd archon-ui-main
npm install -D @playwright/test
npx playwright install
```

**Configuration:**
```typescript
// playwright.config.ts
export default defineConfig({
  testDir: './tests/e2e',
  use: {
    baseURL: 'http://localhost:3737',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    port: 3737,
  },
});
```

**Cost:** Free, open-source
**Effort:** 1-2 weeks initial setup, 1 test per week ongoing

#### 2. Factory-Boy for Test Data
**Status:** Already in dependencies (`factory-boy>=3.3.0`)
**Usage:** Expand beyond fixtures

**Example Pattern:**
```python
# tests/factories.py
import factory
from factory.fuzzy import FuzzyText, FuzzyChoice

class ProjectFactory(factory.Factory):
    class Meta:
        model = dict

    title = FuzzyText(prefix="Project ")
    description = factory.Faker('paragraph')
    pinned = False
    features = []

class TaskFactory(factory.Factory):
    class Meta:
        model = dict

    title = FuzzyText(prefix="Task ")
    status = FuzzyChoice(['todo', 'doing', 'review', 'done'])
    assignee = FuzzyChoice(['User', 'Archon', 'AI IDE Agent'])
```

**Cost:** Free, already installed
**Effort:** 2-3 days to establish patterns

### Near-Term (Q2 2025)

#### 3. k6 for Performance Testing
**Justification:**
- Developer-centric, code-based tests
- Minimal resource consumption
- Excellent CI/CD integration
- JavaScript familiarity for team

**Setup:**
```bash
# Install k6
brew install k6  # macOS
# or download from https://k6.io/
```

**Example Test:**
```javascript
// tests/performance/crawl-load.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '1m', target: 10 },  // Ramp up
    { duration: '3m', target: 10 },  // Steady state
    { duration: '1m', target: 0 },   // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<2000'], // 95% under 2s
  },
};

export default function () {
  const res = http.post('http://localhost:8181/api/knowledge/search', {
    query: 'test search',
    limit: 10,
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 2s': (r) => r.timings.duration < 2000,
  });

  sleep(1);
}
```

**Cost:** Free (open-source), k6 Cloud optional ($0-$499/mo)
**Effort:** 1 week initial setup, ongoing as needed

#### 4. Contract Testing (Pact or OpenAPI)
**Approach 1: Pact (Consumer-Driven)**
**Pros:**
- Consumer-driven contracts
- Excellent for microservices
- Mature ecosystem

**Cons:**
- More complex setup
- Requires broker or PactFlow

**Approach 2: OpenAPI/Swagger Validation**
**Pros:**
- Simpler setup
- Documentation benefit
- FastAPI native support

**Cons:**
- Less powerful than Pact
- Server-driven contracts

**Recommendation:** Start with OpenAPI validation, migrate to Pact if needed

**Setup (OpenAPI):**
```python
# Generate OpenAPI spec from FastAPI
@app.get("/openapi.json")
async def get_openapi_spec():
    return app.openapi()

# Frontend test
describe('API Contract', () => {
  it('should match OpenAPI spec', async () => {
    const spec = await fetch('http://localhost:8181/openapi.json').then(r => r.json());
    const validator = new OpenAPIValidator(spec);

    // Test each endpoint
    const response = await projectService.listProjects();
    expect(validator.validate('/api/projects', 'get', response)).toBe(true);
  });
});
```

**Cost:** Free (OpenAPI), PactFlow ($0-$1000/mo if using Pact)
**Effort:** 1-2 weeks setup, minimal ongoing

### Future Consideration (Q3+ 2025)

#### 5. Visual Regression Testing (Chromatic vs Percy)

**Recommendation:** Chromatic
**Rationale:**
- Component-focused (matches Radix UI usage)
- Storybook integration
- Unlimited parallelization
- Git-based baseline tracking
- Free tier available

**Alternative:** Percy
- Better for full-page testing
- BrowserStack integration
- OCR for text rendering
- More expensive

**Cost:**
- Chromatic: Free for 5000 snapshots/month, then $149-$899/month
- Percy: $299-$899/month

**Effort:** 2-3 weeks setup (requires Storybook), ongoing maintenance

**Decision Point:** Defer until component library stabilizes

#### 6. Mutation Testing (Stryker)
**Purpose:** Test quality measurement
**Cost:** Free, open-source
**Effort:** High (slow test runs)
**Decision:** Defer to post-beta

---

## 5. Coverage Targets by Layer

### Backend Coverage Targets

| Layer | Current | Target Q1 | Target Q2 | Target Stable |
|-------|---------|-----------|-----------|---------------|
| **Overall** | 60% | 65% | 70% | 75% |
| API Routes | ~50% | 70% | 80% | 85% |
| Services | ~65% | 75% | 80% | 85% |
| Utils | ~70% | 80% | 85% | 90% |
| Models | ~40% | 60% | 70% | 75% |
| MCP Tools | ~55% | 70% | 75% | 80% |
| Agents | ~30% | 50% | 60% | 70% |

**Critical Paths (90% target):**
- Knowledge crawling workflow
- RAG search functionality
- Progress tracking
- Project/task CRUD operations

### Frontend Coverage Targets

| Layer | Current | Target Q1 | Target Q2 | Target Stable |
|-------|---------|-----------|-----------|---------------|
| **Overall** | 25% | 45% | 60% | 70% |
| Services | ~40% | 70% | 80% | 85% |
| Hooks | ~50% | 75% | 85% | 90% |
| Components | ~15% | 40% | 60% | 70% |
| Utils | ~60% | 80% | 85% | 90% |
| Pages | 0% | 20% | 40% | 50% |

**Critical Paths (85% target):**
- Knowledge service (API calls)
- Query hooks (TanStack Query)
- Shared utilities (optimistic, apiClient)
- Smart polling hook

### Integration & E2E Targets

| Test Type | Current | Target Q1 | Target Q2 | Target Stable |
|-----------|---------|-----------|-----------|---------------|
| Integration Tests | 2 files | 20 tests | 40 tests | 60+ tests |
| E2E Tests | 0 | 10 flows | 15 flows | 20 flows |
| Contract Tests | 0 | Basic | Complete | Automated |
| Performance Tests | 0 | 5 scenarios | 10 scenarios | 15 scenarios |

---

## 6. Priority Recommendations

### Phase 1: Foundation (Weeks 1-4) 🎯

**Goal:** Establish E2E infrastructure and boost critical path coverage

#### Week 1-2: E2E Setup
- [ ] Configure Playwright
- [ ] Write 3 critical E2E tests:
  1. Knowledge crawl workflow
  2. Project creation and task management
  3. RAG search

**Files to Create:**
- `/home/user/Smart-Founds-Grant/archon-ui-main/playwright.config.ts`
- `/home/user/Smart-Founds-Grant/archon-ui-main/tests/e2e/crawl.spec.ts`
- `/home/user/Smart-Founds-Grant/archon-ui-main/tests/e2e/projects.spec.ts`
- `/home/user/Smart-Founds-Grant/archon-ui-main/tests/e2e/search.spec.ts`

**Success Criteria:**
- 3 E2E tests passing
- CI integration (can run in headless mode)
- Screenshots on failure

#### Week 3-4: Frontend Coverage Boost
- [ ] Test knowledge components:
  - `/home/user/Smart-Founds-Grant/archon-ui-main/src/features/knowledge/components/KnowledgeCard.test.tsx` (exists, expand)
  - Add: `CrawlProgressCard.test.tsx`
  - Add: `SearchResults.test.tsx`

- [ ] Test MCP components:
  - Add: `/home/user/Smart-Founds-Grant/archon-ui-main/src/features/mcp/components/McpToolCard.test.tsx`
  - Add: `McpStatus.test.tsx`

- [ ] Test settings components:
  - Add: `/home/user/Smart-Founds-Grant/archon-ui-main/src/features/settings/components/ProviderConfig.test.tsx`

**Success Criteria:**
- Frontend coverage: 25% → 40%
- 10+ new component tests
- All new tests following established patterns

### Phase 2: Integration Layer (Weeks 5-8) 🎯

**Goal:** Expand integration testing and establish contract testing

#### Week 5-6: Backend Integration Tests
- [ ] Knowledge service integration tests
- [ ] Progress tracking integration tests
- [ ] MCP tool integration tests

**Files to Create:**
- `/home/user/Smart-Founds-Grant/python/tests/integration/test_knowledge_service.py`
- `/home/user/Smart-Founds-Grant/python/tests/integration/test_progress_tracking.py`
- `/home/user/Smart-Founds-Grant/python/tests/integration/test_mcp_tools.py`

**Pattern:**
```python
@pytest.mark.integration
async def test_crawl_and_search_integration(test_db):
    """Integration test: crawl → process → search."""
    # Full workflow test with real database
```

**Success Criteria:**
- 15+ integration tests
- Backend coverage: 60% → 65%
- Integration tests run in CI

#### Week 7-8: Contract Testing
- [ ] Generate OpenAPI spec
- [ ] Validate frontend calls against spec
- [ ] Add contract tests to CI

**Files to Create:**
- `/home/user/Smart-Founds-Grant/archon-ui-main/tests/contract/api-contract.test.ts`

**Success Criteria:**
- API spec auto-generated
- Frontend contract tests passing
- CI blocks breaking changes

### Phase 3: Quality & Performance (Weeks 9-12) 🎯

**Goal:** Add performance testing and improve test quality

#### Week 9-10: Factory Pattern Implementation
- [ ] Create factory classes for test data
- [ ] Migrate conftest.py fixtures to factories
- [ ] Document factory patterns

**Files to Create:**
- `/home/user/Smart-Founds-Grant/python/tests/factories/__init__.py`
- `/home/user/Smart-Founds-Grant/python/tests/factories/project_factory.py`
- `/home/user/Smart-Founds-Grant/python/tests/factories/task_factory.py`
- `/home/user/Smart-Founds-Grant/python/tests/factories/knowledge_factory.py`

**Success Criteria:**
- All tests use factories
- Reduced fixture duplication
- Better test readability

#### Week 11-12: Performance Testing Setup
- [ ] Install and configure k6
- [ ] Write 5 performance tests:
  1. RAG search load test
  2. Concurrent crawl test
  3. API endpoint stress test
  4. WebSocket connection test (if applicable)
  5. Database query performance test

**Files to Create:**
- `/home/user/Smart-Founds-Grant/tests/performance/search-load.js`
- `/home/user/Smart-Founds-Grant/tests/performance/crawl-concurrent.js`
- `/home/user/Smart-Founds-Grant/tests/performance/api-stress.js`

**Success Criteria:**
- 5 performance tests passing
- Baseline metrics established
- Performance regression detection in CI

### Phase 4: Continuous Improvement (Ongoing) 🎯

**Goal:** Maintain and improve test quality

#### Coverage Gates in CI
```yaml
# .github/workflows/test.yml
- name: Check Coverage
  run: |
    npm run test:coverage
    # Fail if coverage drops below thresholds
    if [ $(jq '.total.lines.pct' coverage/coverage-summary.json) -lt 60 ]; then
      echo "Coverage below 60%"
      exit 1
    fi
```

#### Test Quality Metrics
- Track test execution time
- Monitor flaky tests
- Measure coverage trends
- Review mutation testing (quarterly)

#### Documentation
- [ ] Create testing guide: `/home/user/Smart-Founds-Grant/PRPs/ai_docs/TESTING_GUIDE.md`
- [ ] Document patterns and examples
- [ ] Add testing best practices to CLAUDE.md

---

## 7. Test Maintenance Strategy

### Prevent Test Rot
1. **Run tests in CI** - All PRs require passing tests
2. **Fast feedback** - Tests run in <2 minutes
3. **Clear failures** - Descriptive error messages
4. **Quarantine flaky tests** - Mark and fix or remove

### Test Ownership
- Feature owners write tests
- Tests colocated with code
- Tests reviewed with code changes

### Test Refactoring
- Update tests when refactoring code
- Remove tests for removed features
- Keep test patterns DRY but not too DRY

---

## 8. Metrics to Track

### Coverage Metrics
- Statement coverage (current: 60% BE, 25% FE)
- Branch coverage
- Function coverage
- Critical path coverage (target: 90%)

### Quality Metrics
- Test execution time
- Flaky test rate
- Test-to-code ratio
- Mutation score (future)

### Process Metrics
- Tests written per PR
- Coverage trend over time
- CI build success rate
- Time to fix failing tests

---

## 9. Anti-Patterns to Avoid

### ❌ Don't Do This

1. **Testing Implementation Details**
   ```typescript
   // BAD - Testing internal state
   expect(component.state.internalCounter).toBe(5);

   // GOOD - Testing behavior
   expect(screen.getByText('Count: 5')).toBeInTheDocument();
   ```

2. **100% Coverage Obsession**
   - Focus on critical paths, not arbitrary percentage
   - 100% coverage ≠ 100% quality

3. **Brittle E2E Tests**
   - Avoid hardcoded waits (`sleep(5000)`)
   - Use proper waiting strategies (`waitFor`, `expect.toBe`)

4. **Large Test Files**
   - Keep test files focused (<300 lines)
   - Split by concern, not by class

5. **Shared Test State**
   - Each test should be independent
   - Avoid test order dependencies

6. **Mocking Everything**
   - Integration tests should use real implementations
   - Only mock external dependencies

### ✅ Best Practices

1. **AAA Pattern** (Arrange, Act, Assert)
2. **Descriptive Test Names**
   ```typescript
   it('should show error toast when project creation fails')
   ```
3. **One Assertion Per Test** (when reasonable)
4. **Test Behavior, Not Implementation**
5. **Keep Tests Fast** (<100ms for unit tests)

---

## 10. ROI Analysis

### Investment Required

| Phase | Time Investment | Tools Cost | Expected Outcome |
|-------|----------------|------------|------------------|
| Phase 1 | 80 hours | $0 | E2E infrastructure, 40% FE coverage |
| Phase 2 | 80 hours | $0 | Integration tests, contract testing |
| Phase 3 | 80 hours | $0 | Performance testing, factories |
| Phase 4 | 40 hrs/quarter | $0 | Maintain quality |

**Total:** 320 hours setup + 160 hours/year maintenance

### Return on Investment

**Benefits:**
- **Reduced Bug Count:** 40-60% fewer production bugs
- **Faster Development:** Confidence to refactor
- **Better Documentation:** Tests as living documentation
- **Easier Onboarding:** Tests show how system works
- **Beta Exit Confidence:** Quality metrics for stable release

**Cost of NOT Testing:**
- Regression bugs in production
- Customer trust issues
- Slower development (fear of breaking things)
- Higher maintenance costs
- Delayed stable release

---

## 11. Success Criteria

### Q1 2025 Success
- ✅ E2E tests for 3 critical flows
- ✅ Frontend coverage: 45%
- ✅ Backend coverage: 65%
- ✅ Contract testing established
- ✅ CI enforces test passing

### Q2 2025 Success
- ✅ E2E tests for 10+ flows
- ✅ Frontend coverage: 60%
- ✅ Backend coverage: 70%
- ✅ Performance testing established
- ✅ Integration tests comprehensive

### Stable Release Criteria
- ✅ Frontend coverage: 70%
- ✅ Backend coverage: 75%
- ✅ 90% critical path coverage
- ✅ 15+ E2E tests
- ✅ Performance benchmarks established
- ✅ Zero known critical bugs

---

## 12. References

### Tools Documentation
- [Vitest](https://vitest.dev/)
- [Pytest](https://docs.pytest.org/)
- [Playwright](https://playwright.dev/)
- [k6](https://k6.io/docs/)
- [Factory Boy](https://factoryboy.readthedocs.io/)
- [Pact](https://docs.pact.io/)

### Best Practices
- [Testing Trophy (Kent C. Dodds)](https://kentcdodds.com/blog/the-testing-trophy-and-testing-classifications)
- [Write Tests, Not Too Many, Mostly Integration](https://kentcdodds.com/blog/write-tests)
- [Pytest Asyncio Best Practices](https://articles.mergify.com/pytest-asyncio-2/)
- [React Testing Library Best Practices](https://kentcdodds.com/blog/common-mistakes-with-react-testing-library)

### Archon Documentation
- `/home/user/Smart-Founds-Grant/CLAUDE.md`
- `/home/user/Smart-Founds-Grant/PRPs/ai_docs/ARCHITECTURE.md`
- `/home/user/Smart-Founds-Grant/PRPs/ai_docs/QUERY_PATTERNS.md`

---

## Appendix A: Test File Inventory

### Backend Tests (77 files)
```
/home/user/Smart-Founds-Grant/python/tests/
├── conftest.py (comprehensive mocking)
├── test_api_essentials.py (API smoke tests)
├── server/
│   ├── api_routes/ (API endpoint tests)
│   ├── services/ (service layer tests)
│   └── utils/ (utility tests)
├── mcp_server/ (MCP tool tests)
└── progress_tracking/ (progress tracking tests)
```

### Frontend Tests (14 files)
```
/home/user/Smart-Founds-Grant/archon-ui-main/
├── src/features/
│   ├── knowledge/hooks/tests/
│   ├── knowledge/components/tests/
│   ├── knowledge/utils/tests/
│   ├── projects/hooks/tests/
│   ├── projects/components/tests/
│   ├── projects/tasks/hooks/tests/
│   ├── projects/tasks/services/tests/
│   ├── projects/tasks/components/tests/
│   ├── shared/api/tests/
│   ├── shared/hooks/tests/
│   └── shared/utils/tests/
└── tests/integration/ (2 integration tests)
```

---

## Appendix B: Testing Command Reference

### Backend Testing
```bash
# Run all tests
cd /home/user/Smart-Founds-Grant/python
uv run pytest

# Run specific test file
uv run pytest tests/test_api_essentials.py -v

# Run with coverage
uv run pytest --cov=src --cov-report=html

# Run only unit tests
uv run pytest -m unit

# Run only integration tests
uv run pytest -m integration

# Run async tests
uv run pytest -m asyncio
```

### Frontend Testing
```bash
# Run all tests
cd /home/user/Smart-Founds-Grant/archon-ui-main
npm run test

# Run with UI
npm run test:ui

# Run with coverage
npm run test:coverage:stream

# Run specific test
vitest run src/features/projects/hooks/tests/useProjectQueries.test.ts

# Run integration tests
npm run test:integration
```

### E2E Testing (Once Setup)
```bash
# Run E2E tests
npx playwright test

# Run with UI mode
npx playwright test --ui

# Run specific test
npx playwright test tests/e2e/crawl.spec.ts

# Debug mode
npx playwright test --debug
```

### Performance Testing (Once Setup)
```bash
# Run performance test
k6 run tests/performance/search-load.js

# Run with cloud reporting
k6 cloud tests/performance/search-load.js
```

---

## Appendix C: CI/CD Integration Example

```yaml
# .github/workflows/test.yml
name: Test Suite

on:
  pull_request:
  push:
    branches: [main]

jobs:
  backend-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-python@v4
        with:
          python-version: '3.12'
      - name: Install dependencies
        run: |
          cd python
          pip install uv
          uv sync --group all
      - name: Run tests with coverage
        run: |
          cd python
          uv run pytest --cov=src --cov-report=xml
      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./python/coverage.xml

  frontend-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      - name: Install dependencies
        run: |
          cd archon-ui-main
          npm ci
      - name: Run tests with coverage
        run: |
          cd archon-ui-main
          npm run test:coverage:stream
      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./archon-ui-main/coverage/lcov.info

  e2e-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      - name: Install Playwright
        run: |
          cd archon-ui-main
          npm ci
          npx playwright install --with-deps
      - name: Run E2E tests
        run: |
          cd archon-ui-main
          npx playwright test
      - name: Upload test results
        uses: actions/upload-artifact@v3
        if: always()
        with:
          name: playwright-report
          path: archon-ui-main/playwright-report/
```

---

**End of Report**

For questions or clarifications, refer to:
- `/home/user/Smart-Founds-Grant/CLAUDE.md`
- This report: `/home/user/Smart-Founds-Grant/TESTING_STRATEGY_2025.md`
