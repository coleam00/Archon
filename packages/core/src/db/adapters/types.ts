/**
 * Database adapter interface for PostgreSQL/SQLite abstraction
 */

/**
 * Result from a database query
 */
export interface QueryResult<T> {
  readonly rows: readonly T[];
  readonly rowCount: number;
}

/**
 * Minimal database interface that both PostgreSQL and SQLite implement
 */
export interface IDatabase {
  /**
   * Execute a SQL query with parameters
   * @param sql - SQL query string with $1, $2, etc. placeholders
   * @param params - Parameter values (order matches placeholders)
   * @returns Query result with rows and affected row count
   */
  query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;

  /**
   * Execute a callback within a database transaction.
   * All queries using the provided function are atomic -
   * they either all commit or all roll back on error.
   *
   * @param fn - Callback receiving a transaction-scoped query function
   * @returns The callback's return value
   */
  withTransaction<T>(
    fn: (query: <U>(sql: string, params?: unknown[]) => Promise<QueryResult<U>>) => Promise<T>
  ): Promise<T>;

  /**
   * Close the database connection
   */
  close(): Promise<void>;

  /**
   * Get the database type for dialect-specific SQL
   */
  readonly dialect: 'postgres' | 'sqlite';

  /**
   * Get the SQL dialect helpers for this database
   */
  readonly sql: SqlDialect;
}

/**
 * Optional capability for databases that support push notifications
 * (Postgres `LISTEN/NOTIFY`). Kept as a NARROW interface separate from
 * `IDatabase` — only the Postgres adapter implements it; SQLite has no
 * equivalent, so callers feature-detect via `getDbNotificationListener()`.
 */
export interface DbNotificationListener {
  /**
   * Subscribe to a `LISTEN` channel on a dedicated held connection.
   * @param channel - channel name (validated; not parameterizable in `LISTEN`)
   * @param onNotify - called with each notification payload
   * @param onError - called when the underlying connection drops (so the caller can reconnect)
   * @returns an unsubscribe that stops listening and destroys the dedicated connection
   */
  listen(
    channel: string,
    onNotify: (payload: string) => void,
    onError: (err: Error) => void
  ): Promise<() => void>;
}

/**
 * SQL dialect helpers for building queries
 */
export interface SqlDialect {
  /**
   * Generate a UUID (called for each INSERT)
   */
  generateUuid(): string;

  /**
   * SQL expression for current timestamp
   */
  now(): string;

  /**
   * SQL expression for JSON merge (existing || new)
   * @param column - Column name
   * @param paramIndex - Parameter placeholder index
   */
  jsonMerge(column: string, paramIndex: number): string;

  /**
   * SQL expression to check if JSON array contains value
   * @param column - Column name containing JSON
   * @param path - JSON path to array (e.g., 'related_issues')
   * @param paramIndex - Parameter placeholder index for value
   */
  jsonArrayContains(column: string, path: string, paramIndex: number): string;

  /**
   * SQL expression for interval subtraction from now
   * @param paramIndex - Parameter placeholder index for days
   */
  nowMinusDays(paramIndex: number): string;

  /**
   * SQL expression for days since timestamp
   * @param column - Timestamp column name
   */
  daysSince(column: string): string;
}
