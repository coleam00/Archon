# Version Checking and Migration Tracking System Implementation

## Overview
Implement a comprehensive version checking and migration tracking system for Archon to help users stay up-to-date and manage database schema changes when upgrading.

## 1. Version Checking API

### Backend Implementation

#### 1.1 Create Version Check Endpoint
**File**: `python/src/server/api_routes/version_api.py`

Create a new API router with the following endpoint:

```python
GET /api/version/check
```

**Implementation Requirements:**
- Call GitHub API: `https://api.github.com/repos/coleam00/Archon/releases/latest`
- Handle case where no releases exist yet (404 response) - return `update_available: false`
- Compare with current Archon version (stored in a constants file that you will need to create too)
- Return response format:
  ```json
  {
    "current": "1.0.0",
    "latest": "1.1.0",
    "update_available": true,
    "release_url": "https://github.com/coleam00/Archon/releases/tag/v1.1.0",
    "release_notes": "Release notes from GitHub...",
    "published_at": "2024-01-15T10:00:00Z"
  }
  ```
- Use 1-second timeout for GitHub API call
- Cache response for 1 hour to avoid rate limiting (use simple in-memory cache)
- Graceful fallback: return current version as latest on error or if no releases exist
- Add environment variable `ARCHON_VERSION_CHECK_ENABLED` (default: `true`)
- If disabled, on error, or no releases exist, return `update_available: false`

#### 1.2 Version Configuration
**File**: `python/src/server/config/version.py`

Create version configuration:
```python
ARCHON_VERSION = "1.0.0"  # Update this with each release
```

### Frontend Implementation

#### 1.3 Version Query Hook
**File**: `archon-ui-main/src/features/settings/hooks/useVersionQueries.ts`

Create TanStack Query hooks:
- `useVersionCheck()` - Query version endpoint
- Use `STALE_TIMES.rare` (5 minutes) for caching
- Only check when settings page is open

#### 1.4 Version Service
**File**: `archon-ui-main/src/features/settings/services/versionService.ts`

Create service for API calls:
```typescript
export const versionService = {
  async checkVersion(): Promise<VersionCheckResponse> {
    // Call /api/version/check
  }
}
```

#### 1.5 Update Banner Component
**File**: `archon-ui-main/src/features/settings/components/UpdateBanner.tsx`

Create update notification banner:
- Show at top of settings page when update available
- Display current vs latest version
- Link to GitHub release page
- Include "View Upgrade Instructions" button that opens modal

#### 1.6 Upgrade Instructions Modal
**File**: `archon-ui-main/src/features/settings/components/UpgradeInstructionsModal.tsx`

Show upgrade instructions:
- Display standard upgrade steps:
  1. Pull latest changes: `git pull`
  2. Check for pending migrations (link to migrations section)
  3. Rebuild and restart: `docker compose up -d --build`
- Link to GitHub release notes
- Warning about checking migrations before upgrading

## 2. Migration Tracking System

### Database Schema

#### 2.1 Create Migrations Table
**File**: Add to next migration SQL file (e.g., `migration/0.1.0/005_add_migration_tracking.sql`)

```sql
CREATE TABLE IF NOT EXISTS archon_migrations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  version VARCHAR(20) NOT NULL,
  migration_name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(version, migration_name)
);

-- Index for fast lookups
CREATE INDEX idx_migrations_version ON archon_migrations(version);

-- Record this migration as applied
INSERT INTO archon_migrations (version, migration_name)
VALUES ('0.1.0', '005_add_migration_tracking')
ON CONFLICT (version, migration_name) DO NOTHING;
```

### Migration File Structure

#### 2.2 Migration Organization
**Directory Structure (Example, not actual versions we have)**:
```
migration/
├── 1.0.0/
│   └── 001_initial_schema.sql
├── 1.1.0/
│   ├── 001_add_migration_tracking.sql
│   └── 002_add_new_feature.sql
└── 1.2.0/
    └── 001_update_columns.sql
```

**Important**: Each migration SQL file must include an INSERT statement at the end to record itself in the `archon_migrations` table (see example in 2.1).

### Backend Implementation

#### 2.4 Migration Service
**File**: `python/src/server/services/migration_service.py`

Implement migration tracking:
- `get_all_migrations()` - Scan `migration/` folder for all SQL files
- `get_applied_migrations()` - Query archon_migrations table (handle case where table doesn't exist)
- `get_pending_migrations()` - Compare filesystem vs database
- `check_migrations_table_exists()` - Check if archon_migrations table exists (bootstrap case)

#### 2.5 Migration API Endpoints
**File**: `python/src/server/api_routes/migration_api.py`

Create endpoints:

```python
GET /api/migrations/status
```
Returns:
```json
{
  "pending_migrations": [
    {
      "version": "1.1.0",
      "name": "001_add_new_table",
      "sql_content": "CREATE TABLE...",
      "file_path": "1.1.0/001_add_new_table.sql"
    }
  ],
  "applied_migrations": [
    {
      "version": "1.0.0",
      "name": "001_initial_schema",
      "applied_at": "2024-01-01T10:00:00Z"
    }
  ],
  "has_pending": true
}
```

```python
GET /api/migrations/history
```
Returns list of all applied migrations with timestamps

### Frontend Implementation

#### 2.6 Migration Query Hooks
**File**: `archon-ui-main/src/features/settings/hooks/useMigrationQueries.ts`

Create hooks:
- `useMigrationStatus()` - Get pending/applied migrations
- `useMigrationHistory()` - Get migration history

#### 2.7 Migration Service
**File**: `archon-ui-main/src/features/settings/services/migrationService.ts`

API service methods for migration endpoints

#### 2.8 Pending Migrations Modal
**File**: `archon-ui-main/src/features/settings/components/PendingMigrationsModal.tsx`

Display pending migrations:
- Show alert badge on settings page when migrations pending
- Modal with list of pending migrations
- Each migration shows:
  - Version number
  - Migration name
  - Expandable SQL content (with copy button)
- Instructions:
  1. Copy the SQL script
  2. Go to Supabase SQL Editor
  3. Run the script (which will automatically record it as applied)
  4. Click "Refresh Status" to update the UI
- "Refresh Status" button to re-query migration status
- Auto-refresh status every few seconds while modal is open

#### 2.9 Migration Settings Section
**File**: Update existing settings page

Add migrations section showing:
- Current migration status (X pending, Y applied)
- "View Pending Migrations" button (opens modal)
- "View Migration History" link
- Last migration applied timestamp

## 3. Integration Points

### 3.1 Settings Page Updates
**File**: `archon-ui-main/src/pages/SettingsPage.tsx`

Add new sections:
- Version information section with update banner
- Migration status section with pending count

### 3.2 App Initialization Check
**File**: `archon-ui-main/src/App.tsx` or main layout

On app load:
- Check for pending migrations
- If migrations pending, show non-dismissible alert banner
- Banner links to settings page migrations section

## 4. Environment Variables

Add to `.env.example`:
```bash
# Version checking (optional)
ARCHON_VERSION_CHECK_ENABLED=true  # Set to false to disable version checking
```

## 5. Testing Requirements

### Backend Tests
- Mock GitHub API responses (research exact API response format for this)
- Test version comparison logic
- Test migration file scanning
- Test migration status comparison

### Frontend Tests
- Test version check display
- Test migration modal functionality
- Test migration status refresh workflow

## 6. Implementation Order

1. **Phase 1 - Version Checking**:
   - Backend version API
   - Frontend version checking components
   - Settings page integration

2. **Phase 2 - Migration Infrastructure**:
   - Database table creation
   - Migration file structure

3. **Phase 3 - Migration Tracking**:
   - Backend migration service and API
   - Frontend migration components
   - Settings page migration section

4. **Phase 4 - Polish**:
   - App initialization checks
   - Alert banners
   - Testing

## 7. Future Enhancements (Not for Initial Implementation)

- Automatic migration runner for PostgreSQL (when we move from Supabase)
- Migration rollback tracking
- Version-specific upgrade guides
- Pre-upgrade validation checks
- Migration dry-run capability

## Notes for Implementation

### Important Constraints
1. **Supabase Limitation**: We cannot run SQL migrations programmatically due to Supabase SDK restrictions. Users must manually run SQL in Supabase SQL Editor.
2. **Simplicity**: Keep UI simple and focused. No unnecessary toasts or complex workflows.
3. **Beta Consideration**: Since Archon is in beta, version checking should be enabled by default to help users stay current.

### Key Design Decisions
1. **Direct GitHub API**: Use GitHub releases API directly instead of maintaining separate version service
2. **Self-Recording Migrations**: Each migration SQL includes INSERT to record itself when run
3. **Bootstrap Handling**: If migrations table doesn't exist, that's the first pending migration
4. **Simple Tracking**: If migration is in database, it's been run. No complex status tracking.
5. **Non-intrusive Updates**: Version checks only on settings page, not constant polling

### Success Criteria
- Users can see when new version is available
- Users can easily see pending migrations
- Users can copy migration SQL which self-records when run
- System tracks migration history accurately
- Handles bootstrap case when migrations table doesn't exist
- Minimal performance impact on app startup

## 8. Contributing.md Addition

**File**: Add to `CONTRIBUTING.md`

Add the following section:

### Creating Database Migrations

When adding database schema changes:

1. Create a new migration file in the appropriate version folder:
   ```
   migration/{version}/XXX_description.sql
   ```
   Where XXX is a three-digit number (e.g., 001, 002, 003)

2. **IMPORTANT**: Every migration must end with an INSERT statement to record itself:
   ```sql
   -- Your migration SQL here
   CREATE TABLE example_table (
     id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
     name TEXT NOT NULL
   );

   -- REQUIRED: Record this migration
   INSERT INTO archon_migrations (version, migration_name)
   VALUES ('{version}', 'XXX_description')
   ON CONFLICT (version, migration_name) DO NOTHING;
   ```

3. The INSERT ensures the migration is tracked after successful execution
4. Use `ON CONFLICT DO NOTHING` to make migrations idempotent
5. Replace `{version}` with the actual version number (e.g., '0.1.0')
   Replace `XXX_description` with the actual migration filename (e.g., '001_add_new_table')
6. Migration names should be descriptive but concise