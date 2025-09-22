/**
 * Type definitions for database migration tracking and management
 */

export interface MigrationRecord {
  version: string;
  migration_name: string;
  applied_at: string;
  checksum?: string | null;
}

export interface PendingMigration {
  version: string;
  name: string;
  sql_content: string;
  file_path: string;
  checksum?: string | null;
}

export interface MigrationStatusResponse {
  pending_migrations: PendingMigration[];
  applied_migrations: MigrationRecord[];
  has_pending: boolean;
  bootstrap_required: boolean;
  current_version: string;
  pending_count: number;
  applied_count: number;
}

export interface MigrationHistoryResponse {
  migrations: MigrationRecord[];
  total_count: number;
  current_version: string;
}

export interface MigrationState {
  status: MigrationStatusResponse | null;
  isLoading: boolean;
  error: Error | null;
  selectedMigration: PendingMigration | null;
}
