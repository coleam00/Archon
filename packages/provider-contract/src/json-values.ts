import { z } from 'zod';

type WireJson = z.infer<ReturnType<typeof z.json>>;

function isJsonObject(value: unknown): value is Record<string, WireJson> {
  if (value === null || typeof value !== 'object') return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return (
    (prototype === null || prototype === Object.prototype) &&
    Object.values(value).every(isJsonValue)
  );
}

function isJsonValue(value: unknown): value is WireJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return Array.isArray(value) ? value.every(isJsonValue) : isJsonObject(value);
}

export const rawJsonValueSchema = z
  .unknown()
  .refine(isJsonValue, { message: 'Expected a JSON value', abort: true })
  .meta({ $ref: '#/$defs/JsonValue' });
export const rawJsonObjectSchema = z
  .unknown()
  .refine(isJsonObject, { message: 'Expected a JSON object', abort: true })
  .meta({ type: 'object', additionalProperties: { $ref: '#/$defs/JsonValue' } });
