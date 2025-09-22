import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APIServiceError } from "../../types/errors";
import { callAPIWithETag } from "../apiClient";

// Preserve original globals to restore after tests
const originalAbortSignal = global.AbortSignal as any;
const originalFetch = global.fetch;

describe("apiClient (callAPIWithETag)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Reset fetch to undefined to ensure clean state
    if (global.fetch) {
      delete (global as any).fetch;
    }

    // Mock AbortSignal.timeout for test environment
    // Note: Production now uses 20s timeout for database performance issues
    global.AbortSignal = {
      timeout: vi.fn((_ms: number) => ({
        aborted: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        reason: undefined,
      })),
    } as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore original globals to prevent test pollution
    global.AbortSignal = originalAbortSignal;
    if (originalFetch) {
      global.fetch = originalFetch;
    } else if (global.fetch) {
      delete (global as any).fetch;
    }
  });

  describe("callAPIWithETag", () => {
    it("should return data for successful request", async () => {
      const mockData = { id: "123", name: "Test" };
      const mockResponse = {
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockData),
        headers: new Headers({ ETag: 'W/"123456"' }),
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
        }),
      );
    });

    it("should throw APIServiceError for HTTP errors", async () => {
      const errorResponse = {
        ok: false,
        status: 400,
        text: () => Promise.resolve(JSON.stringify({ detail: "Bad request" })),
        headers: new Headers(),
      };

      global.fetch = vi.fn().mockResolvedValue(errorResponse);

      const errorPromise = callAPIWithETag("/test-endpoint");
      await expect(errorPromise).rejects.toThrow(APIServiceError);
      await expect(errorPromise).rejects.toThrow("Bad request");
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

      await expect(callAPIWithETag("/test-endpoint")).rejects.toThrowError(
        new APIServiceError("Failed to call API /test-endpoint: Network error", "NETWORK_ERROR", 500),
      );
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

      await expect(callAPIWithETag("/test-endpoint")).rejects.toThrowError(
        new APIServiceError("Database connection failed", "API_ERROR", 200),
      );
    });

    it("should handle nested error structure from backend", async () => {
      const errorResponse = {
        ok: false,
        status: 422,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              detail: { error: "Validation failed" },
            }),
          ),
        headers: new Headers(),
      };

      global.fetch = vi.fn().mockResolvedValue(errorResponse);

      await expect(callAPIWithETag("/test-endpoint")).rejects.toThrowError(
        new APIServiceError("Validation failed", "HTTP_ERROR", 422),
      );
    });

    it("should handle request timeout", async () => {
      const timeoutError = new Error("Request timeout");
      timeoutError.name = "AbortError";
      global.fetch = vi.fn().mockRejectedValue(timeoutError);

      await expect(callAPIWithETag("/test-endpoint")).rejects.toThrowError(
        new APIServiceError("Failed to call API /test-endpoint: Request timeout", "NETWORK_ERROR", 500),
      );
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
          Authorization: "Bearer token123",
          "Custom-Header": "custom-value",
        },
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            Authorization: "Bearer token123",
            "Custom-Header": "custom-value",
          }),
        }),
      );
    });

    it("should rely on browser cache for 304 handling", async () => {
      // This test verifies our new approach: we never see 304s
      // because the browser handles them and returns cached data
      const mockData = { id: "cached", name: "From Browser Cache" };
      const mockResponse = {
        ok: true,
        status: 200, // Browser converts 304 to 200 with cached data
        json: () => Promise.resolve(mockData),
        headers: new Headers({
          ETag: 'W/"abc123"',
          // Browser might add this header to indicate cache hit
          "X-From-Cache": "true",
        }),
      };

      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const result = await callAPIWithETag("/cached-endpoint");

      expect(result).toEqual(mockData);
      // We just get the data, no special 304 handling needed
      expect(global.fetch).toHaveBeenCalledOnce();
    });

    it("should handle data freshness through TanStack Query staleTime", async () => {
      // This test documents our new mental model:
      // TanStack Query decides WHEN to fetch (staleTime)
      // Browser decides HOW to fetch (with ETag headers)
      // Server decides WHAT to return (fresh data or 304)
      // We just pass data through

      const freshData = { version: 2, data: "Updated" };
      const mockResponse = {
        ok: true,
        status: 200,
        json: () => Promise.resolve(freshData),
        headers: new Headers({ ETag: 'W/"new-etag"' }),
      };

      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const result = await callAPIWithETag("/api/data");

      expect(result).toEqual(freshData);
      // No ETag handling in our code - browser does it all
      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.not.objectContaining({
            "If-None-Match": expect.any(String), // We don't add this
          }),
        }),
      );
    });

    it("should not interfere with browser's HTTP cache mechanism", async () => {
      // Test that we don't add cache-control headers that would
      // interfere with browser's natural ETag handling
      const mockData = { test: "data" };
      const mockResponse = {
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockData),
        headers: new Headers(),
      };

      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      await callAPIWithETag("/test", {
        method: "GET",
      });

      const [, options] = (global.fetch as any).mock.calls[0];

      // Verify we don't add cache-busting headers
      expect(options.headers).not.toHaveProperty("Cache-Control");
      expect(options.headers).not.toHaveProperty("Pragma");
      expect(options.headers).not.toHaveProperty("If-None-Match");
      expect(options.headers).not.toHaveProperty("If-Modified-Since");
    });

    it("should work seamlessly with TanStack Query's caching strategy", async () => {
      // This test documents how the API client integrates with TanStack Query:
      // 1. TanStack Query calls our function when data is stale
      // 2. We make a fetch request
      // 3. Browser adds If-None-Match if it has cached data
      // 4. Server returns 200 (new data) or 304 (not modified)
      // 5. Browser returns data to us (either new or cached)
      // 6. We return data to TanStack Query
      // 7. TanStack Query updates its cache

      const mockData = { workflow: "standard" };
      const mockResponse = {
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockData),
        headers: new Headers({ ETag: 'W/"workflow-v1"' }),
      };

      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const result = await callAPIWithETag("/api/workflow");

      expect(result).toEqual(mockData);
      // That's it! No error handling for 304s, no cache management
      // Just fetch and return
    });

    it("should allow browser to optimize bandwidth automatically", async () => {
      // This test verifies that ETag negotiation is handled by the browser
      // and bandwidth optimization works through the browser's HTTP cache

      const mockData = { size: "large", benefit: "bandwidth saved" };
      const mockResponse = {
        ok: true,
        status: 200, // Even if server sent 304, browser gives us 200
        json: () => Promise.resolve(mockData),
        headers: new Headers({
          ETag: 'W/"large-data"',
          // These headers indicate the browser's cache was used
          Date: new Date().toUTCString(),
          Age: "0", // Indicates how long since fetched from origin
        }),
      };

      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const result = await callAPIWithETag("/api/large-payload");

      expect(result).toEqual(mockData);
      // We get the benefit of 304s without any code complexity
    });

    it("should handle server errors regardless of caching", async () => {
      // Verify error handling works with standard fetch approach
      const errorResponse = {
        ok: false,
        status: 500,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              detail: "Server error",
            }),
          ),
        headers: new Headers(),
      };

      global.fetch = vi.fn().mockResolvedValue(errorResponse);

      await expect(callAPIWithETag("/api/error")).rejects.toThrowError(
        new APIServiceError("Server error", "HTTP_ERROR", 500),
      );
    });
  });

  describe("Browser Cache Integration", () => {
    it("should demonstrate the complete caching flow", async () => {
      // This comprehensive test shows the full cycle:
      // Request 1: Fresh fetch
      // Request 2: Browser handles ETag/304 transparently

      // First request - no cache
      const freshData = { count: 1, status: "fresh" };
      const freshResponse = {
        ok: true,
        status: 200,
        json: () => Promise.resolve(freshData),
        headers: new Headers({
          ETag: 'W/"v1"',
          "Cache-Control": "private, must-revalidate",
        }),
      };

      global.fetch = vi.fn().mockResolvedValueOnce(freshResponse);

      const result1 = await callAPIWithETag("/api/data");
      expect(result1).toEqual(freshData);

      // Second request - browser would handle 304 and return cached data
      // From our perspective, it looks like a normal 200 response
      const cachedResponse = {
        ok: true,
        status: 200, // Browser converts 304 to 200
        json: () => Promise.resolve(freshData), // Same data from cache
        headers: new Headers({
          ETag: 'W/"v1"', // Same ETag
          "Cache-Control": "private, must-revalidate",
          "X-Cache": "HIT", // Some CDNs/proxies add this
        }),
      };

      global.fetch = vi.fn().mockResolvedValueOnce(cachedResponse);

      const result2 = await callAPIWithETag("/api/data");
      expect(result2).toEqual(freshData); // Same data, transparently cached

      // Both requests succeed without any special 304 handling
      expect(result1).toEqual(result2);
    });

    it("should handle data updates transparently", async () => {
      // When server data changes, we get new data automatically

      // Request 1: Initial data
      const v1Data = { version: 1, content: "Original" };
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(v1Data),
        headers: new Headers({ ETag: 'W/"v1"' }),
      });

      const result1 = await callAPIWithETag("/api/content");
      expect(result1).toEqual(v1Data);

      // Data changes on server...

      // Request 2: Updated data (browser sends old ETag, server returns new data)
      const v2Data = { version: 2, content: "Updated" };
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200, // New data, not 304
        json: () => Promise.resolve(v2Data),
        headers: new Headers({ ETag: 'W/"v2"' }), // New ETag
      });

      const result2 = await callAPIWithETag("/api/content");
      expect(result2).toEqual(v2Data); // We get fresh data automatically

      // No special handling needed - it just works
      expect(result2.version).toBeGreaterThan(result1.version);
    });
  });
});
