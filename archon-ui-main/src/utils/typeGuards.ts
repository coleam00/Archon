/**
 * Type guards and utility functions for type safety
 */

import { 
  ProjectDocumentSchema, 
  ProjectFeatureSchema, 
  ProjectDataSchema,
  TaskSourceSchema,
  TaskCodeExampleSchema,
  ProjectSchema,
  TaskSchema
} from '../schemas/project.schemas';
import type { 
  ProjectDocument, 
  ProjectFeature, 
  ProjectData,
  TaskSource,
  TaskCodeExample
} from '../types/jsonb';
import type { Project, Task } from '../types/project';

/**
 * Type guard to check if value is a ProjectDocument
 */
export function isProjectDocument(value: unknown): value is ProjectDocument {
  return ProjectDocumentSchema.safeParse(value).success;
}

/**
 * Type guard to check if value is a ProjectFeature
 */
export function isProjectFeature(value: unknown): value is ProjectFeature {
  return ProjectFeatureSchema.safeParse(value).success;
}

/**
 * Type guard to check if value is ProjectData
 */
export function isProjectData(value: unknown): value is ProjectData {
  return ProjectDataSchema.safeParse(value).success;
}

/**
 * Type guard to check if value is a TaskSource
 */
export function isTaskSource(value: unknown): value is TaskSource {
  return TaskSourceSchema.safeParse(value).success;
}

/**
 * Type guard to check if value is a TaskCodeExample
 */
export function isTaskCodeExample(value: unknown): value is TaskCodeExample {
  return TaskCodeExampleSchema.safeParse(value).success;
}

/**
 * Type guard to check if value is a Project
 */
export function isProject(value: unknown): value is Project {
  return ProjectSchema.safeParse(value).success;
}

/**
 * Type guard to check if value is a Task
 */
export function isTask(value: unknown): value is Task {
  return TaskSchema.safeParse(value).success;
}

/**
 * Exhaustive type checking helper
 * Throws an error if a case is not handled in a switch statement
 */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}

/**
 * Safe JSON parse that returns unknown instead of any
 */
export function safeJsonParse(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * Type guard to check if value is a non-null object
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Type guard to check if value is an array
 */
export function isArray<T>(value: unknown, itemGuard?: (item: unknown) => item is T): value is T[] {
  if (!Array.isArray(value)) return false;
  if (!itemGuard) return true;
  return value.every(itemGuard);
}

/**
 * Type guard to check if value is a string
 */
export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Type guard to check if value is a number
 */
export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !isNaN(value);
}

/**
 * Type guard to check if value is a boolean
 */
export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/**
 * Utility type for deep partial objects
 */
export type DeepPartial<T> = T extends object ? {
  [P in keyof T]?: DeepPartial<T[P]>;
} : T;

/**
 * Utility type for strict omit that checks keys
 */
export type StrictOmit<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>>;

/**
 * Utility type for strict extract
 */
export type StrictExtract<T, U extends T> = U;

/**
 * Type-safe event map for typed event emitters
 */
export type EventMap = Record<string, (...args: unknown[]) => void>;

/**
 * Type-safe event emitter class
 */
export class TypedEventEmitter<T extends EventMap> {
  private handlers: Partial<T> = {};
  
  on<K extends keyof T>(event: K, handler: T[K]): void {
    this.handlers[event] = handler;
  }
  
  off<K extends keyof T>(event: K): void {
    delete this.handlers[event];
  }
  
  emit<K extends keyof T>(event: K, ...args: Parameters<T[K]>): void {
    const handler = this.handlers[event];
    if (handler) {
      handler(...args);
    }
  }
}

/**
 * Utility function to filter out null and undefined values from arrays
 */
export function filterNullish<T>(array: (T | null | undefined)[]): T[] {
  return array.filter((item): item is T => item != null);
}

/**
 * Utility function to safely access nested properties
 */
export function getNestedProperty<T>(
  obj: unknown,
  path: string,
  defaultValue?: T
): T | undefined {
  if (!isObject(obj)) return defaultValue;
  
  const keys = path.split('.');
  let current: unknown = obj;
  
  for (const key of keys) {
    if (!isObject(current) || !(key in current)) {
      return defaultValue;
    }
    current = current[key];
  }
  
  return current as T;
}

/**
 * Type guard to check if a value has a specific property
 */
export function hasProperty<K extends string>(
  obj: unknown,
  key: K
): obj is Record<K, unknown> {
  return isObject(obj) && key in obj;
}

/**
 * Type guard to check if value is a valid UUID
 */
export function isUUID(value: unknown): value is string {
  if (!isString(value)) return false;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(value);
}

/**
 * Type guard to check if value is a valid ISO date string
 */
export function isISODateString(value: unknown): value is string {
  if (!isString(value)) return false;
  const date = new Date(value);
  return !isNaN(date.getTime()) && date.toISOString() === value;
}

/**
 * Utility function to ensure a value is an array
 */
export function ensureArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * Utility function to group array items by a key
 */
export function groupBy<T, K extends keyof T>(
  array: T[],
  key: K
): Record<string, T[]> {
  return array.reduce((groups, item) => {
    const groupKey = String(item[key]);
    if (!groups[groupKey]) {
      groups[groupKey] = [];
    }
    groups[groupKey].push(item);
    return groups;
  }, {} as Record<string, T[]>);
}