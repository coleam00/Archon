# Archon Staging - Quick Start Guide

## Status: ✅ OPERATIONAL

L'instance staging avec backend PostgreSQL est lancée et fonctionnelle.

---

## Access URLs

- **Streamlit UI**: http://localhost:8502
- **Graph Service**: http://localhost:8101 (démarrer via UI)

---

## Current Status

```
✅ Container: archon-staging (Running)
✅ PostgreSQL: Connected (mg_postgres)
✅ UI: Accessible on port 8502
✅ Backend: PostgreSQL operational
✅ All CRUD operations: Tested and working
```

---

## Quick Commands

### Check Status
```bash
docker ps --filter "name=archon-staging"
```

### View Logs
```bash
docker logs archon-staging --tail 50
```

### Restart Container
```bash
docker restart archon-staging
```

### Stop Container
```bash
docker stop archon-staging
```

### Rebuild & Restart
```bash
python run_staging.py
```

---

## What's Working

✅ Container deployment
✅ PostgreSQL connection
✅ Streamlit UI (port 8502)
✅ Database CRUD operations:
  - count()
  - insert()
  - find_by_url()
  - delete_by_source()

---

## Important Notes

1. **Graph Service** must be started manually:
   - Go to http://localhost:8502
   - Navigate to "Agent Service" page
   - Click "Start Service"

2. **Dependencies Update**: `asyncpg` and `pgvector` have been added to requirements.txt for future builds

3. **Database**: Uses existing PostgreSQL container `mg_postgres` on localhost:5432

---

## Validation Test Results

```
=== PostgreSQL Backend Validation ===
Connecting...
✅ Connected
📊 Initial pages count: 0
✅ Inserted test page with ID: 238
✅ Found 1 page(s) by URL
🧹 Deleted 1 test page(s)

✅✅✅ ALL TESTS PASSED ✅✅✅
PostgreSQL backend is FULLY OPERATIONAL!
```

---

## Next Steps

1. **Access the UI**: http://localhost:8502
2. **Start Graph Service**: Via Agent Service page
3. **Test Functionality**: Create agents and verify PostgreSQL backend
4. **Run Integration Tests**: `pytest tests/infrastructure/test_postgres_repository.py -v`

---

For detailed validation report, see: **STAGING_VALIDATION_REPORT.md**
