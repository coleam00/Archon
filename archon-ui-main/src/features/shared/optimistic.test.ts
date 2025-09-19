import { describe, it, expect } from "vitest";
import {
  createOptimisticId,
  createOptimisticEntity,
  isOptimistic,
  replaceOptimisticEntity,
  removeDuplicateEntities,
  cleanOptimisticMetadata,
} from "./optimistic";

describe("Optimistic Update Utilities", () => {
  describe("createOptimisticId", () => {
    it("should generate unique IDs", () => {
      const id1 = createOptimisticId();
      const id2 = createOptimisticId();
      expect(id1).not.toBe(id2);
    });

    it("should generate valid nanoid format", () => {
      const id = createOptimisticId();
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(id.length).toBeGreaterThan(0);
    });
  });

  describe("createOptimisticEntity", () => {
    it("should create entity with optimistic metadata", () => {
      const entity = createOptimisticEntity<{ id: string; name: string }>({
        name: "Test Entity",
      });

      expect(entity._optimistic).toBe(true);
      expect(entity._localId).toBeDefined();
      expect(entity.id).toBe(entity._localId);
      expect(entity.name).toBe("Test Entity");
    });

    it("should apply additional defaults", () => {
      const entity = createOptimisticEntity<{ id: string; name: string; status: string }>(
        { name: "Test" },
        { status: "pending" },
      );

      expect(entity.status).toBe("pending");
    });
  });

  describe("isOptimistic", () => {
    it("should identify optimistic entities", () => {
      const optimistic = { id: "123", _optimistic: true, _localId: "123" };
      const regular = { id: "456" };

      expect(isOptimistic(optimistic)).toBe(true);
      expect(isOptimistic(regular)).toBe(false);
    });
  });

  describe("replaceOptimisticEntity", () => {
    it("should replace optimistic entity by localId", () => {
      const entities = [
        { id: "1", name: "Entity 1" },
        { id: "temp-123", name: "Optimistic", _optimistic: true, _localId: "temp-123" },
        { id: "2", name: "Entity 2" },
      ];

      const serverEntity = { id: "real-id", name: "Server Entity" };
      const result = replaceOptimisticEntity(entities, "temp-123", serverEntity);

      expect(result).toHaveLength(3);
      expect(result[1]).toEqual(serverEntity);
      expect(result[0].id).toBe("1");
      expect(result[2].id).toBe("2");
    });
  });

  describe("removeDuplicateEntities", () => {
    it("should remove duplicate entities by id", () => {
      const entities = [
        { id: "1", name: "First" },
        { id: "2", name: "Second" },
        { id: "1", name: "Duplicate" },
        { id: "3", name: "Third" },
      ];

      const result = removeDuplicateEntities(entities);

      expect(result).toHaveLength(3);
      expect(result[0].name).toBe("First"); // Keeps first occurrence
      expect(result[1].id).toBe("2");
      expect(result[2].id).toBe("3");
    });
  });

  describe("cleanOptimisticMetadata", () => {
    it("should remove optimistic metadata", () => {
      const entity = {
        id: "123",
        name: "Test",
        _optimistic: true,
        _localId: "temp-123",
      };

      const cleaned = cleanOptimisticMetadata(entity);

      expect(cleaned).toEqual({ id: "123", name: "Test" });
      expect("_optimistic" in cleaned).toBe(false);
      expect("_localId" in cleaned).toBe(false);
    });
  });
});
