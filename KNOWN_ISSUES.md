# KNOWN ISSUES - DO NOT DEPLOY

**Status**: Code is currently BROKEN and non-functional
**Last Updated**: 2025-02-23 ~5:00 AM
**Branch**: feature/crawl-checkpoint-resume

## 🚨 CRITICAL: Crawls Failing on Startup

### Symptom
Crawls start successfully but disappear/fail shortly after starting. The crawl is not completing - it's crashing on startup.

### Impact
- ❌ Cannot test basic crawl functionality
- ❌ Cannot test pause/resume/cancel (requires working crawl first)
- ❌ System is non-functional for ingestion

### What We Know
1. Crawl starts (initial request succeeds)
2. Crawl disappears shortly after
3. This is happening BEFORE we can even try to pause/resume
4. Likely something failing early in the pipeline

### What We Don't Know Yet
- Exact point of failure
- Error messages (need to check logs)
- Whether it's related to source creation changes or something else
- Stack trace / exception details

## 📝 Recent Changes That May Be Related

### Source Creation Now Required (Commit: 5e99e72)
Made source creation required with retry logic. If source creation fails after 3 retries, crawl now fails instead of continuing.

**Potential Issue**: If there's a DB connectivity issue or the source creation is failing for some reason, crawls will now fail immediately instead of silently continuing.

**What to Check**:
- Are source records being created successfully?
- Are retries being triggered?
- Is the DB connection working?
- Check logs for "Failed to create source record" messages

### Other Modified Files (Not Committed Yet)
- `python/src/server/api_routes/knowledge_api.py`
- `python/src/server/services/crawling/strategies/sitemap.py`
- `python/src/server/utils/progress/progress_tracker.py`

These may also have issues.

## 🔍 Next Steps for Debugging

### 1. Check Logs
```bash
# Backend logs
docker compose logs -f archon-server | grep -i "error\|failed\|crawl"

# Or if running locally
uv run python -m src.server.main
# Then start a crawl and watch the output
```

### 2. Check Progress Tracker
```python
# In Python REPL or debug script
from src.server.utils.progress.progress_tracker import ProgressTracker

# Get active operations
states = ProgressTracker._progress_states
print(states)

# Check for error status
for pid, state in states.items():
    if state.get("status") == "error":
        print(f"Error in {pid}: {state.get('log')}")
```

### 3. Check Database
```bash
# Check if source records are being created
cd python
uv run python inspect_db.py
# Look for recent source records
```

### 4. Test Source Creation Directly
```python
# Test if source creation works
from src.server.utils import get_supabase_client

supabase = get_supabase_client()
result = supabase.table("archon_sources").select("*").limit(1).execute()
print(result.data)
```

### 5. Rollback Source Creation Changes Temporarily
If source creation is the issue:
```bash
git diff HEAD~1 python/src/server/services/crawling/crawling_service.py
# Review the changes, maybe temporarily revert retry logic
```

## 📋 TODO for Next Session

- [ ] Identify exact point where crawl fails
- [ ] Get full error message and stack trace
- [ ] Determine if source creation changes are the cause
- [ ] Fix the underlying issue
- [ ] Verify crawls work end-to-end
- [ ] Test pause/resume/cancel functionality
- [ ] Update this document with findings
- [ ] Clean up and push working code

## 🧪 Testing Status

### Tests We Created
✅ **test_pause_resume_cancel_api.py**: 8/9 passing (89%)
✅ **test_pause_resume_flow.py**: 6/6 passing (100%)
✅ **Total**: 14/15 tests passing

**Note**: Tests work fine, but they can't validate the full system since crawls aren't working yet.

### What Tests Can't Catch
- Runtime failures in the actual crawl pipeline
- Database connectivity issues
- Network/SSL issues
- Async task exceptions that are swallowed

This is why manual testing is still needed!

## ⚠️ Warning for Other Developers

**DO NOT MERGE THIS BRANCH**

This branch contains:
- ✅ Good test infrastructure
- ✅ Good source creation retry logic (in theory)
- ❌ Broken crawl functionality
- ❌ Unknown issues preventing crawls from completing

**If you pull this branch**:
1. Expect crawls to fail
2. Check KNOWN_ISSUES.md (this file) for status
3. Don't try to use pause/resume until basic crawls work
4. Help debug if you can!

## 📞 Contact

If you're debugging this and find the issue, please update this document with:
1. Root cause
2. Fix applied
3. Verification steps
4. Remove this warning when code is working

---

**Remember**: This is beta development. Breaking things is expected. Document the breakage, fix it, move forward.
