import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';

const mockWarn = mock(() => undefined);
mock.module('@archon/paths', () => ({
  createLogger: mock(() => ({ warn: mockWarn })),
}));

import { parseConfigLenient } from './run-config';

const schema = z.strictObject({
  model: z.string().optional(),
  dirs: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

describe('parseConfigLenient', () => {
  beforeEach(() => {
    mockWarn.mockClear();
  });

  test('drops unknown keys and keeps valid fields', () => {
    expect(parseConfigLenient(schema, { model: 'm', typo: 1 }, 'stub')).toEqual({ model: 'm' });
  });

  test('drops only the rejected array elements', () => {
    expect(parseConfigLenient(schema, { dirs: ['a', 1, 'b', null] }, 'stub')).toEqual({
      dirs: ['a', 'b'],
    });
  });

  test('drops only the rejected record entry', () => {
    expect(parseConfigLenient(schema, { env: { A: 'a', B: 2 } }, 'stub')).toEqual({
      env: { A: 'a' },
    });
  });

  test('logs dropped paths, never their values', () => {
    const raw = { model: 42, env: { SECRET: { token: 'hunter2' } } };
    expect(parseConfigLenient(schema, raw, 'stub')).toEqual({ env: {} });
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(
      { provider: 'stub', fields: ['env.SECRET', 'model'] },
      'provider.config_invalid_fields_dropped'
    );
    expect(raw.env.SECRET.token).toBe('hunter2');
  });
});
