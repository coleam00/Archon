// @archon-test-isolated
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { setLogSink } from '@archon/paths';

const emptyResult = { rows: [], rowCount: 0 };
let statement = async (): Promise<typeof emptyResult> => emptyResult;
let rollback = async (): Promise<void> => {};
let releases = 0;

mock.module('pg', () => ({
  Pool: class {
    query = () => statement();
    async connect() {
      return {
        query: async (sql: string) => {
          if (sql === 'SELECT inventory') return statement();
          if (sql === 'ROLLBACK') await rollback();
          return { rows: [{ current: true }], rowCount: 1 };
        },
        release() {
          releases++;
        },
      };
    }
    on() {}
    async end() {}
  },
}));

mock.module('../bundled-schema', () => ({ getSchemaSQL: () => '-- noop schema' }));

import { PostgresAdapter } from './postgres';

beforeEach(() => {
  statement = async () => emptyResult;
  rollback = async () => {};
  releases = 0;
});

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

for (const exhausted of [false, true]) {
  test.each([
    { code: '08006', expectedCode: '08006' },
    { code: undefined, expectedCode: undefined },
    { code: 'token=private-secret', expectedCode: undefined },
    { code: '08006\n', expectedCode: undefined },
    { code: 8006, expectedCode: undefined },
  ])(
    `failed rollback logs retain only validated identity for $code (exhausted: ${exhausted})`,
    async ({ code, expectedCode }) => {
      const adapter = new PostgresAdapter('postgresql://localhost/test');
      await adapter.query('SELECT inventory');
      releases = 0;
      const lines: string[] = [];
      setLogSink(line => lines.push(line));
      const failure = Object.assign(new Error('private statement content'), { code: '40001' });
      const rollbackFailure = Object.assign(
        new Error('token=private-secret stored private content'),
        {
          code,
          detail: 'private database detail',
          query: 'private SQL query',
        }
      );
      rollbackFailure.stack = 'private rollback stack';
      rollback = async () => {
        throw rollbackFailure;
      };
      let calls = 0;
      statement = async () => {
        calls++;
        if (exhausted || calls === 1) throw failure;
        return emptyResult;
      };

      const result = adapter.withTransaction(query => query('SELECT inventory'));
      if (exhausted) await expect(result).rejects.toBe(failure);
      else expect(await result).toEqual(emptyResult);
      expect(calls).toBe(exhausted ? 4 : 2);
      expect(releases).toBe(calls);

      const logs: Record<string, unknown>[] = lines.map(line => JSON.parse(line));
      expect(logs).toHaveLength(exhausted ? 7 : 2);
      for (const [index, logged] of logs.entries()) {
        const isRollback = index % 2 === 0;
        expect(logged).toMatchObject({
          module: 'db.postgres',
          level: isRollback ? 50 : 40,
          msg: isRollback
            ? 'db.postgres_transaction_rollback_failed'
            : 'db.postgres_transaction_retry',
        });
        expect(logged.code).toBe(isRollback ? expectedCode : '40001');
        if (!isRollback) expect(logged.attempt).toBe((index + 1) / 2);
        expect(logged).not.toHaveProperty('err');
        expect(logged).not.toHaveProperty('stack');
      }
      expect(lines.join('')).not.toContain('private');
      expect(lines.join('')).not.toContain('token=');
      await adapter.close();
    }
  );
}
