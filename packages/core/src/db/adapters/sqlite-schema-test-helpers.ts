import { getSchemaSQL } from '../bundled-schema';

const TABLE_CONSTRAINTS = new Set(['check', 'constraint', 'foreign', 'primary', 'unique']);

function addDeclaredColumns(body: string, columns: Set<string>): void {
  for (const declaration of splitTopLevelCommas(body)) {
    const identifier = declaration.trim().match(/^(?:"([^"]+)"|([a-z_][a-z0-9_]*))/i);
    if (!identifier) continue;

    const column = identifier[1] ?? identifier[2].toLowerCase();
    if (!TABLE_CONSTRAINTS.has(column.toLowerCase())) columns.add(column);
  }
}

/** Extract Archon table columns declared or added by the Postgres migration. */
export function postgresArchonColumns(): Map<string, Set<string>> {
  // Comments are stripped first: `migrations/000_combined.sql` writes `);`
  // inside prose comments as a matter of house style, and any paren- or
  // semicolon-sensitive scan would otherwise end a table body early.
  const sql = stripSqlComments(getSchemaSQL());
  const columnsByTable = new Map<string, Set<string>>();
  const createTableRe = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+"?([a-z0-9_]+)"?\s*\(/gi;

  for (const match of sql.matchAll(createTableRe)) {
    const table = match[1].toLowerCase();
    if (!table.startsWith('remote_agent_')) continue;

    const columns = columnsByTable.get(table) ?? new Set<string>();
    // Depth-tracked so nested parens in REFERENCES / CHECK / DEFAULT
    // clauses cannot terminate the body or split a declaration.
    const body = readBalancedParens(sql, match.index + match[0].length - 1);
    addDeclaredColumns(body, columns);
    columnsByTable.set(table, columns);
  }

  const addColumnRe =
    /ALTER TABLE\s+"?([a-z0-9_]+)"?\s+ADD COLUMN IF NOT EXISTS\s+"?([a-z_][a-z0-9_]*)"?/gi;
  for (const match of sql.matchAll(addColumnRe)) {
    const table = match[1].toLowerCase();
    if (!table.startsWith('remote_agent_')) continue;
    const columns = columnsByTable.get(table) ?? new Set<string>();
    columns.add(match[2].toLowerCase());
    columnsByTable.set(table, columns);
  }

  const derivedTableRe =
    /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+"?([a-z0-9_]+)"?\s+AS\s+SELECT\s+\*\s+FROM\s+"?([a-z0-9_]+)"?\s+WHERE\s+false/gi;
  for (const match of sql.matchAll(derivedTableRe)) {
    const owner = columnsByTable.get(match[2].toLowerCase());
    if (!owner) throw new Error(`Missing schema owner: ${match[2]}`);
    columnsByTable.set(match[1].toLowerCase(), new Set(owner));
  }

  return columnsByTable;
}

/**
 * Advance past a SQL string literal / quoted identifier that opens at `start`,
 * returning the index of its closing quote. Doubled quotes escape.
 */
function skipQuoted(sql: string, start: number): number {
  const quote = sql[start];
  for (let i = start + 1; i < sql.length; i++) {
    if (sql[i] !== quote) continue;
    // A doubled quote escapes itself — not the end of the literal.
    if (sql[i + 1] === quote) i++;
    else return i;
  }
  return sql.length;
}

/** Remove SQL line and block comments, preserving quoted text. */
export function stripSqlComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "'" || sql[i] === '"') {
      const end = skipQuoted(sql, i);
      out += sql.slice(i, end + 1);
      i = end + 1;
    } else if (sql[i] === '-' && sql[i + 1] === '-') {
      i = skipLineComment(sql, i);
    } else if (sql[i] === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else {
      out += sql[i];
      i++;
    }
  }
  return out;
}

/**
 * Return the text between the `(` at `openIndex` and its matching `)`, tracking
 * nesting depth so `REFERENCES t(id)` / `CHECK (id = 1)` / `DEFAULT NOW()` do
 * not end the body early. Throws rather than returning a truncated body — a
 * silently short column list is the failure mode this whole parser guards.
 */
export function readBalancedParens(sql: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < sql.length; i++) {
    if (sql[i] === "'" || sql[i] === '"') i = skipQuoted(sql, i);
    else if (sql[i] === '(') depth++;
    else if (sql[i] === ')' && --depth === 0) return sql.slice(openIndex + 1, i);
  }
  throw new Error(`Unbalanced parentheses in schema SQL at index ${openIndex}`);
}

/** Split a CREATE TABLE body on its top-level commas (depth- and quote-aware). */
function splitTopLevelCommas(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "'" || body[i] === '"') i = skipQuoted(body, i);
    else if (body[i] === '(') depth++;
    else if (body[i] === ')') depth--;
    else if (body[i] === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

function skipLineComment(sql: string, start: number): number {
  let i = start;
  while (i < sql.length && sql[i] !== '\n') i++;
  return i;
}
