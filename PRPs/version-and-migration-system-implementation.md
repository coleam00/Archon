name: "Version Checking and Migration Tracking System Implementation PRP"
description: |
  Complete implementation guide for Archon's version checking and migration tracking system with comprehensive research and patterns

---

## Goal

**Feature Goal**: Implement a comprehensive version checking and migration tracking system for Archon that enables users to stay up-to-date and manage database schema changes safely when upgrading.

**Deliverable**: Backend API endpoints for version checking and migration status, frontend UI components integrated with settings page, self-bootstrapping migration system with tracking.

**Success Definition**: Users can see when updates are available, view pending migrations with SQL content, copy migration SQL to run manually in Supabase, and track migration history - all with proper error handling and caching.

## User Persona

**Target User**: Archon administrators and self-hosting users

**Use Case**:
1. Check for new Archon releases when visiting settings page
2. View pending database migrations before upgrading
3. Copy and apply migrations manually via Supabase SQL Editor
4. Track migration history to verify system state

**User Journey**:
1. User visits Settings page → sees version status (current vs latest)
2. If update available → sees prominent alert with link to release notes
3. Checks migrations section → sees X pending migrations
4. Opens pending migrations modal → views SQL content for each
5. Copies SQL → runs in Supabase → migration self-records
6. Refreshes status → sees migration applied successfully

**Pain Points Addressed**:
- No visibility into available updates
- Database schema changes break functionality after git pull
- No tracking of which migrations have been applied
- Manual migration process lacks guidance

## Why

- **Business value**: Reduces support burden by helping users stay current and manage upgrades properly
- **Integration**: Extends existing settings page with new capabilities following established patterns
- **Problems solved**: Version awareness, migration tracking, safe schema evolution during beta phase

## What

Implement version checking against GitHub releases API, database migration tracking with self-recording pattern, and intuitive UI for managing both. System must handle bootstrap case (no migrations table), cache GitHub API responses to avoid rate limits, and provide clear migration guidance for Supabase's manual SQL execution requirement.

### Success Criteria

- [ ] Version checking shows current vs latest with update availability
- [ ] Migration system tracks applied vs pending migrations accurately
- [ ] Bootstrap case handled automatically when migrations table doesn't exist
- [ ] GitHub API cached for 1 hour to avoid rate limits
- [ ] Migrations include self-recording SQL at the end
- [ ] UI provides clear copy buttons for migration SQL
- [ ] Error states handled gracefully with fallback behavior

## All Needed Context

### Context Completeness Check

_This PRP includes comprehensive research findings, existing codebase patterns, external API documentation, and detailed implementation patterns needed for one-pass implementation success._

### Documentation & References

```yaml
# MUST READ - Include these in your context window
- url: https://docs.github.com/en/rest/releases/releases#get-the-latest-release
  why: GitHub API endpoint for fetching latest release with exact response schema
  critical: Returns 404 when no releases exist yet - must handle gracefully

- file: python/src/server/api_routes/progress_api.py
  why: Pattern for API routes with ETag support and error handling
  pattern: Router setup, ETag generation/checking, HTTPException handling
  gotcha: ETags use generate_etag from utils, check_etag returns boolean

- file: python/src/server/services/credential_service.py
  why: Service layer pattern with Supabase client initialization
  pattern: Service class with async methods, _get_supabase_client pattern
  gotcha: Must handle Supabase connection failures gracefully

- file: archon-ui-main/src/features/projects/hooks/useProjectQueries.ts
  why: TanStack Query v5 patterns with query keys factory
  pattern: Query keys factory, optimistic updates, smart polling usage
  gotcha: Use DISABLED_QUERY_KEY for disabled queries, STALE_TIMES constants

- file: archon-ui-main/src/features/projects/services/projectService.ts
  why: Frontend service pattern using callAPIWithETag
  pattern: Service object with async methods, error handling
  gotcha: Always use callAPIWithETag for consistency

- docfile: PRPs/ai_docs/QUERY_PATTERNS.md
  why: Complete TanStack Query patterns and conventions
  section: Query key factories, shared patterns usage

- docfile: PRPs/ai_docs/ARCHITECTURE.md
  why: System architecture and directory structure conventions
  section: Backend structure, Frontend vertical slices
```

### Current Codebase tree

```bash
python/
├── src/
│   └── server/
│       ├── api_routes/
│       │   ├── settings_api.py
│       │   ├── progress_api.py
│       │   └── projects_api.py
│       ├── services/
│       │   ├── credential_service.py
│       │   └── source_management_service.py
│       ├── config/
│       │   ├── config.py
│       │   └── logfire_config.py
│       ├── utils/
│       │   └── etag_utils.py
│       └── main.py

archon-ui-main/
├── src/
│   ├── pages/
│   │   └── SettingsPage.tsx
│   ├── features/
│   │   ├── projects/
│   │   │   ├── hooks/
│   │   │   ├── services/
│   │   │   └── types/
│   │   └── shared/
│   │       ├── apiWithEtag.ts
│   │       └── queryPatterns.ts
│   └── components/
│       └── settings/

migration/
├── 0.1.0/
│   ├── 001_add_source_url_display_name.sql
│   ├── 002_add_hybrid_search_tsvector.sql
│   ├── 003_ollama_implementation.sql
│   └── 004_add_priority_column_to_tasks.sql
```

### Desired Codebase tree with files to be added

```bash
python/
├── src/
│   └── server/
│       ├── api_routes/
│       │   ├── version_api.py              # NEW: Version checking endpoints
│       │   └── migration_api.py            # NEW: Migration tracking endpoints
│       ├── services/
│       │   ├── version_service.py          # NEW: GitHub API integration
│       │   └── migration_service.py        # NEW: Migration scanning/tracking
│       ├── config/
│       │   └── version.py                  # NEW: Version constant
│       └── utils/
│           └── semantic_version.py         # NEW: Version comparison utilities

archon-ui-main/
├── src/
│   └── features/
│       └── settings/                       # NEW: Settings feature slice
│           ├── version/                    # NEW: Version checking feature
│           │   ├── components/
│           │   │   ├── VersionStatusCard.tsx
│           │   │   ├── UpdateBanner.tsx
│           │   │   └── UpgradeInstructionsModal.tsx
│           │   ├── hooks/
│           │   │   └── useVersionQueries.ts
│           │   ├── services/
│           │   │   └── versionService.ts
│           │   └── types/
│           │       └── index.ts
│           └── migrations/                 # NEW: Migration tracking feature
│               ├── components/
│               │   ├── MigrationStatusCard.tsx
│               │   ├── PendingMigrationsModal.tsx
│               │   └── MigrationHistory.tsx
│               ├── hooks/
│               │   └── useMigrationQueries.ts
│               ├── services/
│               │   └── migrationService.ts
│               └── types/
│                   └── index.ts

migration/
├── 0.1.0/
│   └── 005_add_migration_tracking.sql      # NEW: Creates archon_migrations table
```

### Known Gotchas & Library Quirks

```python
# CRITICAL: GitHub API returns 404 when repository has no releases
# Must handle this case and return update_available: false

# CRITICAL: Supabase cannot execute SQL programmatically via SDK
# Users must manually copy and run migrations in Supabase SQL Editor

# CRITICAL: Bootstrap case - migrations table may not exist on first run
# Migration service must check table existence before querying

# CRITICAL: Frontend components in components/settings/ are legacy
# New features should go in features/settings/ following vertical slice

# CRITICAL: All database tables must use archon_ prefix
# This is Supabase convention for application tables

# CRITICAL: ETag checking returns True if client cache is stale
# Confusing but check_etag(if_none_match, current) returns True when NOT matching

# CRITICAL: Use existing copyToClipboard utility for clipboard operations
# Import from features/shared/utils/clipboard.ts - handles fallbacks automatically
```

### GitHub API Response Format

```json
// Exact response from GET /repos/{owner}/{repo}/releases/latest
{
    "url": "https://api.github.com/repos/coleam00/Archon/releases/123456789",
    "html_url": "https://github.com/coleam00/Archon/releases/tag/v1.0.0",
    "id": 217869415,
    "author": {
        "login": "coleam00",
        "id": 102023614,
        "avatar_url": "https://avatars.githubusercontent.com/u/102023614?v=4",
        "html_url": "https://github.com/coleam00"
    },
    "tag_name": "v1.0.0",
    "target_commitish": "main",
    "name": "Release v1.0.0",
    "draft": false,
    "prerelease": false,
    "created_at": "2025-05-12T01:53:52Z",
    "published_at": "2025-05-12T02:15:57Z",
    "assets": [
        {
            "id": 253814093,
            "name": "archon-1.0.0-linux.AppImage",
            "size": 171227028,
            "download_count": 1249,
            "browser_download_url": "https://github.com/coleam00/Archon/releases/download/v1.0.0/archon-1.0.0-linux.AppImage",
            "content_type": "application/octet-stream"
        }
    ],
    "tarball_url": "https://api.github.com/repos/coleam00/Archon/tarball/v1.0.0",
    "zipball_url": "https://api.github.com/repos/coleam00/Archon/zipball/v1.0.0",
    "body": "# Release Notes\n\n## What's Changed\n* Feature X by @user in #123\n* Bug fix Y by @user in #456\n\nFull changelog: https://github.com/coleam00/Archon/compare/v0.9.0...v1.0.0",
    "reactions": {
        "total_count": 89,
        "+1": 31,
        "heart": 17
    }
}

// 404 Response when no releases exist:
{
    "message": "Not Found",
    "documentation_url": "https://docs.github.com/rest/releases/releases#get-the-latest-release"
}
```

## Implementation Blueprint

### Data models and structure

```python
# python/src/server/config/version.py
ARCHON_VERSION = "0.1.0"  # Update with each release

# python/src/server/api_routes/version_api.py - Response models
from pydantic import BaseModel
from datetime import datetime
from typing import Optional

class VersionCheckResponse(BaseModel):
    current: str
    latest: Optional[str]
    update_available: bool
    release_url: Optional[str]
    release_notes: Optional[str]
    published_at: Optional[datetime]
    check_error: Optional[str] = None

# python/src/server/api_routes/migration_api.py - Response models
class MigrationRecord(BaseModel):
    version: str
    migration_name: str
    applied_at: datetime
    checksum: Optional[str] = None

class PendingMigration(BaseModel):
    version: str
    name: str
    sql_content: str
    file_path: str

class MigrationStatusResponse(BaseModel):
    pending_migrations: list[PendingMigration]
    applied_migrations: list[MigrationRecord]
    has_pending: bool
    bootstrap_required: bool = False
```

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: CREATE python/src/server/config/version.py
  - IMPLEMENT: ARCHON_VERSION constant = "0.1.0"
  - NAMING: Simple string constant for now, can evolve to dataclass later
  - PLACEMENT: Config directory with other configuration

Task 2: CREATE migration/0.1.0/005_add_migration_tracking.sql
  - IMPLEMENT: CREATE TABLE archon_migrations with self-recording INSERT
  - FOLLOW pattern: Existing migrations in 0.1.0/ directory
  - CRITICAL: Include ON CONFLICT DO NOTHING for idempotency
  - PLACEMENT: Next sequential number in 0.1.0 directory
  - EXACT SQL:
    ```sql
    CREATE TABLE IF NOT EXISTS archon_migrations (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      version VARCHAR(20) NOT NULL,
      migration_name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      UNIQUE(version, migration_name)
    );

    -- Index for fast lookups
    CREATE INDEX IF NOT EXISTS idx_migrations_version ON archon_migrations(version);

    -- Record this migration as applied
    INSERT INTO archon_migrations (version, migration_name)
    VALUES ('0.1.0', '005_add_migration_tracking')
    ON CONFLICT (version, migration_name) DO NOTHING;
    ```

Task 3: CREATE python/src/server/services/migration_service.py
  - IMPLEMENT: MigrationService class with filesystem scanning
  - FOLLOW pattern: credential_service.py for Supabase client pattern
  - NAMING: get_all_migrations(), get_applied_migrations(), get_pending_migrations()
  - DEPENDENCIES: Needs Supabase client, filesystem access
  - PLACEMENT: Services directory

Task 4: CREATE python/src/server/services/version_service.py
  - IMPLEMENT: VersionService with GitHub API integration and caching
  - FOLLOW pattern: Service class with async methods
  - NAMING: get_latest_version(), check_for_updates()
  - DEPENDENCIES: httpx for GitHub API, in-memory cache with TTL
  - PLACEMENT: Services directory

Task 5: CREATE python/src/server/api_routes/version_api.py
  - IMPLEMENT: FastAPI router with /check endpoint
  - FOLLOW pattern: progress_api.py for router setup and ETag support
  - NAMING: GET /api/version/check
  - DEPENDENCIES: Import version_service, ETag utilities
  - PLACEMENT: API routes directory

Task 6: CREATE python/src/server/api_routes/migration_api.py
  - IMPLEMENT: FastAPI router with /status and /history endpoints
  - FOLLOW pattern: projects_api.py for router and response patterns
  - NAMING: GET /api/migrations/status, GET /api/migrations/history
  - DEPENDENCIES: Import migration_service
  - PLACEMENT: API routes directory

Task 7: MODIFY python/src/server/main.py
  - INTEGRATE: Register new routers (version_api, migration_api)
  - FIND pattern: Existing router imports and registrations
  - ADD: from .api_routes import version_api, migration_api
  - ADD: app.include_router(version_api.router), app.include_router(migration_api.router)
  - PRESERVE: Existing router registrations

Task 8: CREATE archon-ui-main/src/features/settings/version/types/index.ts
  - IMPLEMENT: TypeScript types matching backend response models
  - FOLLOW pattern: projects/types/index.ts for type definitions
  - NAMING: VersionCheckResponse, VersionStatus interfaces
  - PLACEMENT: New feature slice under features/settings

Task 9: CREATE archon-ui-main/src/features/settings/version/services/versionService.ts
  - IMPLEMENT: Service object with API methods
  - FOLLOW pattern: projectService.ts using callAPIWithETag
  - NAMING: checkVersion() async method
  - DEPENDENCIES: Import callAPIWithETag from shared
  - PLACEMENT: Version feature services directory

Task 10: CREATE archon-ui-main/src/features/settings/version/hooks/useVersionQueries.ts
  - IMPLEMENT: TanStack Query hooks with query keys factory
  - FOLLOW pattern: useProjectQueries.ts for query patterns
  - NAMING: versionKeys factory, useVersionCheck() hook
  - DEPENDENCIES: Import from @tanstack/react-query, shared patterns
  - PLACEMENT: Version feature hooks directory

Task 11: CREATE archon-ui-main/src/features/settings/version/components/UpdateBanner.tsx
  - IMPLEMENT: Banner component showing update availability
  - FOLLOW pattern: Existing UI components with Tailwind styling
  - NAMING: UpdateBanner component
  - DEPENDENCIES: Use version hooks, Lucide icons
  - PLACEMENT: Version feature components directory

Task 12: CREATE archon-ui-main/src/features/settings/migrations/types/index.ts
  - IMPLEMENT: Migration types (MigrationRecord, PendingMigration)
  - FOLLOW pattern: Type definition patterns
  - PLACEMENT: Migrations feature types directory

Task 13: CREATE archon-ui-main/src/features/settings/migrations/services/migrationService.ts
  - IMPLEMENT: API service for migration endpoints
  - FOLLOW pattern: Service object pattern
  - NAMING: getMigrationStatus(), getMigrationHistory()
  - PLACEMENT: Migrations feature services directory

Task 14: CREATE archon-ui-main/src/features/settings/migrations/hooks/useMigrationQueries.ts
  - IMPLEMENT: Migration query hooks
  - FOLLOW pattern: Query hooks with smart polling
  - NAMING: migrationKeys factory, useMigrationStatus()
  - PLACEMENT: Migrations feature hooks directory

Task 15: CREATE archon-ui-main/src/features/settings/migrations/components/PendingMigrationsModal.tsx
  - IMPLEMENT: Modal showing pending migrations with copy buttons
  - FOLLOW pattern: Modal components with framer-motion
  - CRITICAL: Use copyToClipboard from features/shared/utils/clipboard.ts
  - REFERENCE: See ProjectCardActions.tsx for usage pattern with showToast
  - PLACEMENT: Migrations feature components directory

Task 16: MODIFY archon-ui-main/src/pages/SettingsPage.tsx
  - INTEGRATE: Import and render new version/migration components
  - ADD: UpdateBanner at top if update available
  - ADD: Migration status section with pending count
  - PRESERVE: Existing settings sections
```

### Implementation Patterns & Key Details

```python
# Version Service Pattern - Caching with TTL
class VersionService:
    def __init__(self):
        self._cache: dict | None = None
        self._cache_time: datetime | None = None
        self._cache_ttl = 3600  # 1 hour

    async def get_latest_version(self) -> dict:
        # PATTERN: Check cache first (follow credential_service.py caching)
        if self._is_cache_valid():
            return self._cache

        # GOTCHA: GitHub API returns 404 for repos with no releases
        try:
            async with httpx.AsyncClient(timeout=1.0) as client:
                response = await client.get(
                    "https://api.github.com/repos/coleam00/Archon/releases/latest",
                    headers={"Accept": "application/vnd.github.v3+json"}
                )
                if response.status_code == 404:
                    # No releases yet
                    return {"update_available": False, "latest": None}
                response.raise_for_status()
                data = response.json()
                self._cache = data
                self._cache_time = datetime.now()
                return data
        except Exception as e:
            # CRITICAL: Return cached data or safe default on failure
            if self._cache:
                return self._cache
            return {"error": str(e), "update_available": False}

# Migration Service Pattern - Bootstrap handling
class MigrationService:
    async def check_migrations_table_exists(self) -> bool:
        # PATTERN: Check table existence before querying
        supabase = self._get_supabase_client()
        try:
            # Query information_schema to check if table exists
            result = supabase.rpc(
                "check_table_exists",
                {"table_name": "archon_migrations"}
            ).execute()
            return result.data
        except:
            # Assume table doesn't exist if query fails
            return False

    async def get_pending_migrations(self) -> list[PendingMigration]:
        # CRITICAL: Check table exists first
        if not await self.check_migrations_table_exists():
            # Bootstrap case - all migrations are pending
            return await self.get_all_filesystem_migrations()

        # Normal case - compare filesystem vs database
        all_migrations = await self.scan_migration_directory()
        applied = await self.get_applied_migrations()
        # ... comparison logic

# Frontend Pattern - Smart Polling with Visibility
export function useVersionCheck() {
  const { refetchInterval } = useSmartPolling(30000); // 30 seconds base

  return useQuery({
    queryKey: versionKeys.check(),
    queryFn: () => versionService.checkVersion(),
    staleTime: STALE_TIMES.rare, // 5 minutes
    refetchInterval, // Pauses when tab hidden
    retry: false, // Don't retry on 404
  });
}
```

### Integration Points

```yaml
DATABASE:
  - migration: "005_add_migration_tracking.sql creates archon_migrations table"
  - index: "CREATE INDEX idx_archon_migrations_version ON archon_migrations(version)"

CONFIG:
  - add to: python/src/server/config/version.py
  - pattern: 'ARCHON_VERSION = "0.1.0"'

ROUTES:
  - add to: python/src/server/main.py
  - pattern: |
      from .api_routes import version_api, migration_api
      app.include_router(version_api.router)
      app.include_router(migration_api.router)

FRONTEND:
  - modify: archon-ui-main/src/pages/SettingsPage.tsx
  - imports: "import { UpdateBanner } from '../features/settings/version/components'"
  - render: "Add <UpdateBanner /> component at top of page"
```

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# Backend validation
cd python
ruff check src/server/api_routes/version_api.py src/server/api_routes/migration_api.py --fix
ruff check src/server/services/version_service.py src/server/services/migration_service.py --fix
mypy src/server/api_routes/ src/server/services/

# Frontend validation
cd archon-ui-main
npm run biome:fix src/features/settings/
npx tsc --noEmit 2>&1 | grep "src/features/settings"

# Expected: Zero errors. Fix any issues before proceeding.
```

### Level 2: Unit Tests (Component Validation)

```bash
# Backend tests to create
cd python

# Test version service:
# - Test GitHub API 404 handling returns update_available: false
# - Test cache TTL expiration and refresh
# - Test version comparison logic (0.1.0 vs 1.0.0, v-prefix handling)
# - Test fallback to cached data on network failure
uv run pytest tests/server/services/test_version_service.py -v

# Test migration service:
# - Test filesystem scanning finds all .sql files
# - Test bootstrap case when table doesn't exist
# - Test pending vs applied migration comparison
# - Test checksum calculation for migration files
uv run pytest tests/server/services/test_migration_service.py -v
```

## Final Validation Checklist

### Technical Validation

- [ ] Both validation levels completed successfully
- [ ] Backend tests pass: `uv run pytest tests/ -v`
- [ ] No linting errors: `ruff check src/`
- [ ] No type errors: `mypy src/`
- [ ] Frontend builds: `npm run build`

### Feature Validation

- [ ] Version check shows current vs latest correctly
- [ ] Update banner appears when new version available
- [ ] Migration status shows accurate pending count
- [ ] Pending migrations modal displays SQL content
- [ ] Copy buttons work for migration SQL
- [ ] Refresh updates migration status after applying
- [ ] Bootstrap case creates migrations table
- [ ] GitHub API failures handled gracefully

### Code Quality Validation

- [ ] Follows existing FastAPI patterns for routes
- [ ] Uses service layer pattern consistently
- [ ] Frontend follows vertical slice architecture
- [ ] TanStack Query patterns properly implemented
- [ ] Error handling matches existing patterns
- [ ] ETag support integrated where appropriate

### Documentation & Deployment

- [ ] Version constant documented for release process
- [ ] Migration self-recording pattern documented
- [ ] Environment variables documented if added
- [ ] CONTRIBUTING.md updated with migration guidelines

---

## Anti-Patterns to Avoid

- ❌ Don't try to execute migrations programmatically (Supabase limitation)
- ❌ Don't poll GitHub API without caching (rate limits)
- ❌ Don't assume migrations table exists (bootstrap case)
- ❌ Don't hardcode version strings outside of config/version.py
- ❌ Don't skip self-recording INSERT in migrations
- ❌ Don't use synchronous HTTP calls in async functions
- ❌ Don't put new UI components in legacy components/ directory