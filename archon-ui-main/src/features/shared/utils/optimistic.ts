import { nanoid } from "nanoid";

/**
 * Interface for optimistic entities that haven't been persisted to the server yet
 */
export interface OptimisticEntity {
  /** Indicates this is an optimistic (client-side only) entity */
  _optimistic: boolean;
  /** Local ID for tracking during optimistic updates */
  _localId: string;
}

/**
 * Type guard to check if an entity is optimistic
 */
export function isOptimistic<T>(entity: T & Partial<OptimisticEntity>): entity is T & OptimisticEntity {
  return entity._optimistic === true;
}

/**
 * Generate a stable optimistic ID using nanoid
 */
export function createOptimisticId(): string {
  return nanoid();
}

/**
 * Create an optimistic entity with proper metadata
 */
export function createOptimisticEntity<T extends { id: string }>(
  data: Omit<T, "id" | keyof OptimisticEntity>,
  additionalDefaults?: Partial<T>,
): T & OptimisticEntity {
  const optimisticId = createOptimisticId();
  return {
    ...additionalDefaults,
    ...data,
    id: optimisticId,
    _optimistic: true,
    _localId: optimisticId,
  } as T & OptimisticEntity;
}

/**
 * Replace an optimistic entity with the server response
 * Matches by _localId to handle race conditions
 */
export function replaceOptimisticEntity<T extends { id: string }>(
  entities: (T & Partial<OptimisticEntity>)[],
  localId: string,
  serverEntity: T,
): T[] {
  return entities.map((entity) => {
    if ("_localId" in entity && entity._localId === localId) {
      return serverEntity;
    }
    return entity;
  });
}

/**
 * Remove duplicate entities after optimistic replacement
 * Keeps the first occurrence of each unique ID
 */
export function removeDuplicateEntities<T extends { id: string }>(entities: T[]): T[] {
  const seen = new Set<string>();
  return entities.filter((entity) => {
    if (seen.has(entity.id)) {
      return false;
    }
    seen.add(entity.id);
    return true;
  });
}

/**
 * Clean up optimistic metadata from an entity
 */
export function cleanOptimisticMetadata<T>(entity: T & Partial<OptimisticEntity>): T {
  const { _optimistic, _localId, ...cleaned } = entity;
  return cleaned as T;
}
