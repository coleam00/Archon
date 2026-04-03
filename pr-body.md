## Summary

- Add `LOCAL_DB=true` option to run Archon **entirely locally** with no Supabase cloud dependency — all data stays on the user's machine
- Add 3 new Docker services: PostgreSQL 16 + pgvector, PostgREST, and an Nginx proxy for Supabase URL compatibility
- Zero Python code refactoring needed — the `supabase-py` client works identically in both modes
- Fully backward compatible — existing Supabase cloud users are unaffected

## Architecture

```
PostgreSQL 16 + pgvector → PostgREST → Nginx Proxy (/rest/v1/ → /) → supabase-py
```

The Nginx proxy maps `/rest/v1/` paths to PostgREST's root paths, making it fully compatible with the `supabase-py` client.

## What's Changed

### New files
- `local-db/nginx.conf` — Nginx proxy for Supabase URL compatibility
- `local-db/complete_setup_local.sql` — Complete DB schema with RLS policies adapted for PostgREST (no `auth.role()`)

### Modified files
- `docker-compose.yml` — Add `archon-db`, `archon-postgrest`, `archon-postgrest-proxy` services (profile: `local-db`)
- `.env.example` — Add `LOCAL_DB` toggle and local database configuration
- `python/src/server/config/config.py` — Skip JWT validation in local mode, auto-configure URLs
- `python/src/server/services/client_manager.py` — Local database URL handling
- `python/src/server/services/credential_service.py` — Local database URL handling
- `Makefile` — Add `dev-local-db`, `local-db-up/down/reset/logs` commands
- `README.md` — Document local database mode with architecture diagrams

## Usage

```bash
# In .env:
LOCAL_DB=true

# Then start:
make dev-local-db
# or:
docker compose --profile full --profile local-db up -d
```

No Supabase account needed. No manual SQL execution. Everything starts automatically.

## Why This Approach

There have been several attempts at database abstraction (#918, #915, #375) involving heavy Python refactoring. This approach avoids all that by using PostgREST as a drop-in replacement for the Supabase REST API, keeping the existing `supabase-py` client calls 100% intact.
