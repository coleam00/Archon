import { expect } from 'bun:test';
import type { z } from 'zod';

export function validationError(result: z.ZodSafeParseResult<unknown>): z.ZodError {
  expect(result.success).toBe(false);
  if (result.success) throw new Error('Expected schema validation to fail');
  return result.error;
}
