import { describe, it, expect, vi, beforeEach } from "vitest";
import { callAPIWithETag, NotModifiedError } from "./apiWithEtag";
import { ProjectServiceError } from "../projects/shared/api";

describe("apiWithEtag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetAllMocks();

    // Mock AbortSignal.timeout for test environment
    global.AbortSignal = {
      timeout: vi.fn((ms: number) => ({
        aborted: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        reason: undefined,
      })),
    } as any;
  });

  describe("callAPIWithETag", () => {
    it("should return data for successful request", async () => {
      const mockData = { id: "123", name: "Test" };
      const mockResponse = {
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockData),
        headers: new Headers({ "ETag": "W/\"123456\"" }),
      };

      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const result = await callAPIWithETag("/test-endpoint");

      expect(result).toEqual(mockData);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/test-endpoint"),
        expect.objectContaining({
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
        })
      );
    });

    it("should throw NotModifiedError for 304 response", async () => {
      const mockResponse = {
        ok: false,
        status: 304,
        headers: new Headers(),
      };

      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      await expect(callAPIWithETag("/test-endpoint")).rejects.toThrow(NotModifiedError);
      await expect(callAPIWithETag("/test-endpoint")).rejects.toThrow("Resource not modified");
    });

    it("should throw ProjectServiceError for HTTP errors", async () => {
      const errorResponse = {
        ok: false,
        status: 400,
        text: () => Promise.resolve(JSON.stringify({ detail: "Bad request" })),
        headers: new Headers(),
      };

      global.fetch = vi.fn().mockResolvedValue(errorResponse);

      await expect(callAPIWithETag("/test-endpoint")).rejects.toThrow(ProjectServiceError);
      await expect(callAPIWithETag("/test-endpoint")).rejects.toThrow("Bad request");
    });

    it("should return undefined for 204 No Content", async () => {
      const mockResponse = {
        ok: true,
        status: 204,
        headers: new Headers(),
      };

      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const result = await callAPIWithETag("/test-endpoint", { method: "DELETE" });

      expect(result).toBeUndefined();
    });

    it("should handle network errors properly", async () => {
      const networkError = new Error("Network error");
      global.fetch = vi.fn().mockRejectedValue(networkError);

      await expect(callAPIWithETag("/test-endpoint")).rejects.toThrow(ProjectServiceError);
      await expect(callAPIWithETag("/test-endpoint")).rejects.toThrow("Failed to call API /test-endpoint: Network error");
    });

    it("should handle API errors in response body", async () => {
      const mockData = { error: "Database connection failed" };
      const mockResponse = {
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockData),
        headers: new Headers(),
      };

      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      await expect(callAPIWithETag("/test-endpoint")).rejects.toThrow(ProjectServiceError);
      await expect(callAPIWithETag("/test-endpoint")).rejects.toThrow("Database connection failed");
    });

    it("should handle nested error structure from backend", async () => {
      const errorResponse = {
        ok: false,
        status: 422,
        text: () => Promise.resolve(JSON.stringify({
          detail: { error: "Validation failed" }
        })),
        headers: new Headers(),
      };

      global.fetch = vi.fn().mockResolvedValue(errorResponse);

      await expect(callAPIWithETag("/test-endpoint")).rejects.toThrow(ProjectServiceError);
      await expect(callAPIWithETag("/test-endpoint")).rejects.toThrow("Validation failed");
    });

    it("should handle request timeout", async () => {
      const timeoutError = new Error("Request timeout");
      timeoutError.name = "AbortError";
      global.fetch = vi.fn().mockRejectedValue(timeoutError);

      await expect(callAPIWithETag("/test-endpoint")).rejects.toThrow(ProjectServiceError);
      await expect(callAPIWithETag("/test-endpoint")).rejects.toThrow("Failed to call API /test-endpoint: Request timeout");
    });

    it("should pass custom headers correctly", async () => {
      const mockData = { success: true };
      const mockResponse = {
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockData),
        headers: new Headers(),
      };

      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      await callAPIWithETag("/test-endpoint", {
        headers: {
          "Authorization": "Bearer token123",
          "Custom-Header": "custom-value",
        },
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            "Authorization": "Bearer token123",
            "Custom-Header": "custom-value",
          }),
        })
      );
    });
  });

  describe("NotModifiedError", () => {
    it("should create error with correct properties", () => {
      const error = new NotModifiedError();

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(NotModifiedError);
      expect(error.name).toBe("NotModifiedError");
      expect(error.message).toBe("Resource not modified");
    });
  });
});