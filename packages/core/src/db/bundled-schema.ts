import schemaSQL from '../../../../migrations/000_combined.sql' with { type: 'text' };

export function getSchemaSQL(): string {
  return schemaSQL;
}
