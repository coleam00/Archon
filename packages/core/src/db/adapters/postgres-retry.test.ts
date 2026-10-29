// @archon-test-isolated
import { afterEach, expect, mock, test } from 'bun:test';
import { setLogSink } from '@archon/paths';

const emptyResult = { rows: [], rowCount: 0 };
let statement = async (): Promise<typeof emptyResult> => emptyResult;

mock.module('pg', () => ({
  Pool: class {
    query = () => statement();
    async connect() {
      return {
        query: async (sql: string) => {
          if (sql === 'SELECT inventory') return statement();
          return { rows: [{ current: true }], rowCount: 1 };
        },
        release() {},
      };
    }
    on() {}
    async end() {}
  },
}));

mock.module('../bundled-schema', () => ({ getSchemaSQL: () => '-- noop schema' }));

import { PostgresAdapter } from './postgres';

afterEach(() => setLogSink(undefined));

for (const operation of ['query', 'transaction'] as const) {
  for (const code of ['40001', '40P01']) {
    test.each([false, true])(
      `${operation} retry logs retain ${code} without private text (exhausted: %s)`,
      async exhausted => {
        const lines: string[] = [];
        setLogSink(line => lines.push(line));
        const adapter = new PostgresAdapter('postgresql://localhost/test');
        const failure = Object.assign(new Error('token=private-secret stored private content'), {
          code,
          detail: 'private database detail',
          query: 'private SQL query',
        });
        failure.stack = 'private error stack';
        let calls = 0;
        statement = async () => {
          calls++;
          if (exhausted || calls <= 3) throw failure;
          return emptyResult;
        };

        const result =
          operation === 'query'
            ? adapter.query('SELECT inventory')
            : adapter.withTransaction(query => query('SELECT inventory'));
        if (exhausted) await expect(result).rejects.toBe(failure);
        else expect(await result).toEqual(emptyResult);
        expect(calls).toBe(4);

        const logs: Record<string, unknown>[] = lines.map(line => JSON.parse(line));
        expect(logs).toHaveLength(3);
        for (const [index, logged] of logs.entries()) {
          expect(logged).toMatchObject({
            level: 40,
            module: 'db.postgres',
            msg: `db.postgres_${operation}_retry`,
            code,
            attempt: index + 1,
          });
          expect(logged).not.toHaveProperty('err');
          expect(logged).not.toHaveProperty('stack');
        }
        expect(lines.join('')).not.toContain('private');
        expect(lines.join('')).not.toContain('token=');
        await adapter.close();
      }
    );
  }
}
