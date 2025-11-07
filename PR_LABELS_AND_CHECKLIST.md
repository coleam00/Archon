# Pull Request Labels & Review Checklist

## 🏷️ Suggested Labels

Add these labels to the PR on GitHub:

### Priority
- `priority: high` - Critical fixes included

### Type
- `type: feature` - New multi-Ollama support
- `type: enhancement` - Performance optimizations
- `type: bug fix` - Optimistic updates fix
- `type: testing` - Massive test coverage expansion
- `type: documentation` - New comprehensive docs

### Area
- `area: frontend` - React/TypeScript changes
- `area: backend` - Python/FastAPI changes
- `area: performance` - DELETE optimization
- `area: tests` - 129 new tests
- `area: ci/cd` - CI workflow updates

### Status
- `status: ready for review` - All checks passing
- `status: needs testing` - Manual testing recommended

### Impact
- `impact: high` - System-wide improvements

---

## ✅ Reviewer Checklist

### Code Quality

#### Frontend Changes
- [ ] **KnowledgeFilterContext.tsx** - Context pattern follows React best practices
- [ ] **useKnowledgeQueries.ts** - Mutation logic is sound
- [ ] **KnowledgeView.tsx** - Context provider properly wraps component
- [ ] **Test files** - Component tests follow established patterns
- [ ] **setup.ts** - Icon mocking enhancement doesn't break existing tests

#### Backend Changes
- [ ] **mcp_session_manager.py** - Session tracking thread-safe and efficient
- [ ] **source_management_service.py** - Batch deletion logic handles edge cases
- [ ] **llm_provider_service.py** - Load balancing algorithm is fair
- [ ] **credential_service.py** - Ollama instance CRUD operations secure
- [ ] **migration_service.py** - Index migration idempotent and safe
- [ ] **document_processing.py** - Structured logging doesn't lose important data
- [ ] **progress_tracker.py** - Logging changes maintain observability

#### Test Files
- [ ] **test_agent_chat_api.py** - Covers success and error cases
- [ ] **test_ollama_api.py** - Tests health checks and instance management
- [ ] **test_settings_api.py** - Tests credential encryption
- [ ] **test_mcp_api.py** - Tests session tracking
- [ ] **Other test files** - Follow pytest best practices

### Functionality

#### Critical Features
- [ ] **Optimistic Updates** - Instant UI feedback works in all filter scenarios
- [ ] **MCP Session Tracking** - Sessions appear in /api/mcp/sessions
- [ ] **DELETE Performance** - Large sources delete in <10 seconds
- [ ] **Multi-Ollama** - Multiple instances can be added and load balanced

#### CI/CD
- [ ] **GitHub Actions** - Frontend tests run without errors
- [ ] **Linting** - Ruff, MyPy, ESLint, Biome all pass
- [ ] **TypeScript** - No type errors

### Performance

- [ ] **DELETE Operations** - Verify 4-5x improvement on large datasets
- [ ] **Optimistic Updates** - No perceptible delay in UI
- [ ] **Load Balancing** - Round-robin distributes requests evenly
- [ ] **Health Checks** - Ollama health checks don't block requests

### Documentation

- [ ] **OLLAMA_MULTI_INSTANCE_IMPLEMENTATION.md** - Complete and accurate
- [ ] **TESTING_STRATEGY.md** - Aligns with project philosophy
- [ ] **TESTING_ANALYSIS.md** - Accurate coverage analysis
- [ ] **Code comments** - Complex logic well-documented
- [ ] **Commit messages** - Clear and descriptive

### Security

- [ ] **Credential Storage** - Ollama API keys stored securely
- [ ] **Session Management** - No session hijacking vulnerabilities
- [ ] **Database Operations** - Batch deletes don't expose sensitive data
- [ ] **API Endpoints** - New endpoints follow authentication patterns

### Breaking Changes

- [ ] **Backward Compatibility** - Existing configurations still work
- [ ] **Migration Path** - Clear instructions for database index migration
- [ ] **Deprecations** - None introduced

---

## 🧪 Manual Testing Guide

### Test 1: Optimistic Updates (5 minutes)
1. Start frontend: `cd archon-ui-main && npm run dev`
2. Navigate to Knowledge page
3. Crawl a URL (e.g., https://docs.python.org)
4. **Expected**: Source appears in list INSTANTLY (no delay)
5. **Pass/Fail**: _________

### Test 2: DELETE Performance (5 minutes)
1. Create source with 1000+ documents (crawl large site)
2. Note timestamp: __________
3. Click delete on source
4. Note completion timestamp: __________
5. **Expected**: Completes in <10 seconds
6. **Pass/Fail**: _________

### Test 3: MCP Session Tracking (3 minutes)
1. Start MCP server: `docker compose up archon-mcp -d`
2. Check sessions: `curl http://localhost:8181/api/mcp/sessions`
3. **Expected**: Returns JSON with active_sessions count
4. **Pass/Fail**: _________

### Test 4: Multi-Ollama (10 minutes)
1. Install Ollama on two different machines/ports
2. Go to Settings → Providers in UI
3. Add both Ollama instances
4. Send multiple requests
5. Check logs for load balancing
6. **Expected**: Requests distributed across instances
7. **Pass/Fail**: _________

### Test 5: Frontend Tests in CI (Next Push)
1. Make trivial change (add comment)
2. Push to branch
3. Watch GitHub Actions
4. **Expected**: Frontend tests run and pass
5. **Pass/Fail**: _________

### Test 6: Component Tests (5 minutes)
```bash
cd archon-ui-main
npm run test
```
6. **Expected**: All 16 new tests pass
7. **Pass/Fail**: _________

### Test 7: Backend Tests (5 minutes)
```bash
cd python
uv run pytest tests/server/api_routes/ -v
```
7. **Expected**: 91+ tests pass
8. **Pass/Fail**: _________

---

## 🚨 Regression Testing

### Areas to Watch
- [ ] Existing crawl functionality still works
- [ ] Project/task management unaffected
- [ ] Existing Ollama single-instance setup still works
- [ ] No performance degradation in unrelated features
- [ ] Existing tests still pass

---

## 📊 Metrics to Track After Merge

### Performance
- Average DELETE time for sources with 1K+ docs
- UI feedback delay (should be <100ms)
- Ollama request distribution (should be ~even)

### Quality
- Test coverage percentage (backend and frontend)
- CI success rate
- Number of test failures per week

### Adoption
- Number of Ollama instances configured
- MCP session activity
- Crawl success rate

---

## 🎯 Post-Merge Actions

### Immediate (Day 1)
- [ ] Apply database indexes: `POST /api/migration/apply-deletion-indexes`
- [ ] Restart all services: `docker compose up --build -d`
- [ ] Monitor logs for errors
- [ ] Test critical user flows

### Short-term (Week 1)
- [ ] Monitor DELETE performance metrics
- [ ] Watch for Ollama load balancing issues
- [ ] Check CI test stability
- [ ] Gather user feedback on optimistic updates

### Medium-term (Month 1)
- [ ] Review test coverage trends
- [ ] Identify remaining untested areas
- [ ] Consider additional Ollama features
- [ ] Optimize based on production metrics

---

## ❓ Questions for Maintainers

1. **Should we make database index migration automatic on startup?**
   - Pro: Ensures all instances have indexes
   - Con: Startup time increase

2. **Should Ollama load balancing be configurable?**
   - Currently: Round-robin only
   - Options: Weighted, least-connections, random

3. **Should we add E2E tests for critical paths?**
   - Currently: Deferred to post-beta
   - Value: Catch integration issues

4. **Should frontend test coverage be enforced in CI?**
   - Currently: Tests run but no minimum coverage
   - Options: 50%, 70%, 80% threshold

---

## 📝 Review Sign-off

### Code Review
- **Reviewer**: _______________
- **Date**: _______________
- **Approved**: [ ] Yes [ ] No [ ] With changes
- **Comments**:

### Testing Review
- **Tester**: _______________
- **Date**: _______________
- **All tests pass**: [ ] Yes [ ] No
- **Manual testing complete**: [ ] Yes [ ] No
- **Comments**:

### Security Review
- **Reviewer**: _______________
- **Date**: _______________
- **No security concerns**: [ ] Yes [ ] No
- **Comments**:

### Final Approval
- **Maintainer**: _______________
- **Date**: _______________
- **Merge approved**: [ ] Yes [ ] No
- **Merge strategy**: [ ] Squash [ ] Merge commit [ ] Rebase

---

**Ready for review!** 🚀
