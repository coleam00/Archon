import { expect } from 'bun:test';
import { z } from 'zod';
import acp from './acp-v1.schema.json';

export function checkAcp(name: keyof typeof acp.$defs, value: unknown): void {
  // The upstream JSON includes nullable type arrays supported at runtime but absent
  // from zod's JSONSchema input type. Keep the published fixture unchanged.
  const schema = z.fromJSONSchema({
    $ref: `#/$defs/${name}`,
    $defs: acp.$defs,
  } as unknown as Parameters<typeof z.fromJSONSchema>[0]);
  expect(schema.safeParse(value).success).toBe(true);
}
