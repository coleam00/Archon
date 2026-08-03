/**
 * Database adapter exports
 */
export type { IDatabase, QueryResult, SqlDialect } from './types';
export { PostgresAdapter, postgresDialect } from './postgres';
export { SqliteAdapter, sqliteDialect } from './sqlite';
