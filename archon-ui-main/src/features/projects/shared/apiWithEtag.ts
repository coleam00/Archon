/**
 * ETag-aware API client for TanStack Query integration
 * Reduces bandwidth by 70-90% through HTTP 304 responses
 */

import { API_BASE_URL } from "../../../config/api";
import { ProjectServiceError } from "./api";

// ETag and data cache stores - ensure they're initialized
const etagCache = typeof Map !== "undefined" ? new Map<string, string>() : null;
const dataCache = typeof Map !== "undefined" ? new Map<string, unknown>() : null;

// Debug flag for console logging (only in dev or when VITE_SHOW_DEVTOOLS is enabled)
const ETAG_DEBUG =
  typeof import.meta !== "undefined" &&
  (import.meta.env?.DEV === true || import.meta.env?.VITE_SHOW_DEVTOOLS === "true");

/**
 * Build full URL with test environment handling
 * Ensures consistent URL construction for cache keys
 */
function buildFullUrl(cleanEndpoint: string): string {
  let fullUrl = `${API_BASE_URL}${cleanEndpoint}`;

  // Only convert to absolute URL in test environment
  const isTestEnv = typeof process !== "undefined" && process.env?.NODE_ENV === "test";

  if (isTestEnv && !fullUrl.startsWith("http")) {
    const testHost = "localhost";
    const testPort = process.env?.ARCHON_SERVER_PORT || "8181";
    fullUrl = `http://${testHost}:${testPort}${fullUrl}`;
    if (ETAG_DEBUG) {
      console.log(`[Test] Converted URL: ${fullUrl}`);
    }
  }

  return fullUrl;
}

// Generate cache key from endpoint and options
function getCacheKey(endpoint: string, options: RequestInit = {}): string {
  // Include method in cache key (GET vs POST, etc), normalized to uppercase
  const method = (options.method || "GET").toUpperCase();
  return `${method}:${endpoint}`;
}

/**
 * ETag-aware API call function for JSON APIs
 * Handles 304 Not Modified responses by returning cached data
 *
 * NOTE: This wrapper is designed for JSON-only API calls.
 * For file uploads or FormData requests, use fetch() directly.
 */
export async function callAPIWithETag<T = unknown>(endpoint: string, options: RequestInit = {}): Promise<T> {
  try {
    // Clean endpoint
    const cleanEndpoint = endpoint.startsWith("/api") ? endpoint.substring(4) : endpoint;

    // Construct the full URL
    const fullUrl = buildFullUrl(cleanEndpoint);

    const cacheKey = getCacheKey(fullUrl, options);
    const method = (options.method || "GET").toUpperCase();

    // Get stored ETag for this endpoint
    const storedEtag = etagCache?.get(cacheKey);

    // Build headers with If-None-Match if we have an ETag
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...((options.headers as Record<string, string>) || {}),
    };

    // Only add If-None-Match for GET requests
    if (storedEtag && method === "GET") {
      headers["If-None-Match"] = storedEtag;
    }

    // Make the request with timeout
    const response = await fetch(fullUrl, {
      ...options,
      headers,
      signal: options.signal ?? AbortSignal.timeout(10000), // 10 second timeout
    });

    // Handle 304 Not Modified - return cached data
    if (response.status === 304) {
      const cachedData = dataCache?.get(cacheKey);
      if (cachedData) {
        // Console log for debugging
        if (ETAG_DEBUG) {
          console.log(`%c[ETag] Cache hit (304) for ${cleanEndpoint}`, "color: #10b981; font-weight: bold");
        }
        return cachedData as T;
      }
      // Cache miss on 304 - this shouldn't happen but handle gracefully
      if (ETAG_DEBUG) {
        console.error(`[ETag] 304 received but no cached data for ${cleanEndpoint}`);
      }
      // Clear the stale ETag to prevent this from happening again
      etagCache?.delete(cacheKey);
      throw new ProjectServiceError(
        `Cache miss on 304 response for ${cleanEndpoint}. Please retry the request.`,
        "CACHE_MISS",
        304,
      );
    }

    // Handle errors
    if (!response.ok && response.status !== 304) {
      let errorMessage = `HTTP error! status: ${response.status}`;
      try {
        const errorBody = await response.text();
        if (errorBody) {
          const errorJson = JSON.parse(errorBody);
          // Handle nested error structure from backend {"detail": {"error": "message"}}
          if (typeof errorJson.detail === "object" && errorJson.detail !== null && "error" in errorJson.detail) {
            errorMessage = errorJson.detail.error;
          } else if (errorJson.detail) {
            errorMessage = errorJson.detail;
          } else if (errorJson.error) {
            errorMessage = errorJson.error;
          }
        }
      } catch (_e) {
        // Ignore parse errors
      }
      throw new ProjectServiceError(errorMessage, "HTTP_ERROR", response.status);
    }

    // Handle 204 No Content (DELETE operations)
    if (response.status === 204) {
      // Clear caches for this endpoint on successful deletion
      etagCache?.delete(cacheKey);
      dataCache?.delete(cacheKey);

      // Also clear any cached GET for this resource
      // since the resource no longer exists
      const getKey = `GET:${fullUrl}`;
      etagCache?.delete(getKey);
      dataCache?.delete(getKey);

      return undefined as T;
    }

    // Parse response data
    const result = await response.json();

    // Check for API errors
    if (result.error) {
      throw new ProjectServiceError(result.error, "API_ERROR", response.status);
    }

    // Store ETag if present (only for GET requests)
    const newEtag = response.headers.get("ETag");
    if (newEtag && method === "GET") {
      etagCache?.set(cacheKey, newEtag);
      // Store the data along with ETag
      dataCache?.set(cacheKey, result);
      if (ETAG_DEBUG) {
        console.log(
          `%c[ETag] Cached new data for ${cleanEndpoint}`,
          "color: #3b82f6; font-weight: bold",
          `ETag: ${newEtag.substring(0, 12)}...`,
        );
      }
    }

    return result as T;
  } catch (error) {
    if (error instanceof ProjectServiceError) {
      throw error;
    }

    throw new ProjectServiceError(
      `Failed to call API ${endpoint}: ${error instanceof Error ? error.message : "Unknown error"}`,
      "NETWORK_ERROR",
      500,
    );
  }
}

/**
 * Clear ETag caches - useful for logout or data refresh
 */
export function clearETagCache(): void {
  etagCache?.clear();
  dataCache?.clear();
  if (ETAG_DEBUG) {
    console.debug("[ETag] Cache cleared");
  }
}

/**
 * Invalidate specific endpoint cache
 * Useful after mutations that affect specific resources
 */
export function invalidateETagCache(endpoint: string, method = "GET"): void {
  const cleanEndpoint = endpoint.startsWith("/api") ? endpoint.substring(4) : endpoint;
  const fullUrl = buildFullUrl(cleanEndpoint);
  const normalizedMethod = method.toUpperCase();
  const cacheKey = `${normalizedMethod}:${fullUrl}`;

  etagCache?.delete(cacheKey);
  dataCache?.delete(cacheKey);
  if (ETAG_DEBUG) {
    console.debug(`[ETag] Cache invalidated for ${cleanEndpoint}`);
  }
}

/**
 * Get cache statistics for debugging
 */
export function getETagCacheStats(): {
  etagCount: number;
  dataCacheSize: number;
  keys: string[];
} {
  return {
    etagCount: etagCache?.size || 0,
    dataCacheSize: dataCache?.size || 0,
    keys: etagCache ? Array.from(etagCache.keys()) : [],
  };
}
