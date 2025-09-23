/**
 * Simple API client for TanStack Query integration
 *
 * IMPORTANT: The Fetch API automatically handles ETags and HTTP caching for bandwidth optimization.
 * We do NOT explicitly handle 304 responses because:
 * 1. The browser's native HTTP cache handles If-None-Match headers automatically
 * 2. When server returns 304, fetch returns the cached stored response (typically as 200) and updates cache headers
 * 3. TanStack Query manages data freshness through staleTime configuration
 *
 * This simplification eliminates complex ETag management while maintaining bandwidth efficiency.
 * For cache control, configure TanStack Query's staleTime/gcTime instead of manual HTTP caching.
 */

import { API_BASE_URL } from "../../../config/api";
import { APIServiceError } from "../types/errors";

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
  }

  return fullUrl;
}

/**
 * Simple API call function for JSON APIs and FormData uploads
 * Browser automatically handles ETags/304s through its HTTP cache
 *
 * Features:
 * - Automatic FormData detection (avoids setting Content-Type header)
 * - JSON API support with proper Content-Type headers
 * - Built-in timeout and error handling
 * - ETag/304 optimization through browser HTTP cache
 */
export async function callAPIWithETag<T = unknown>(endpoint: string, options: RequestInit = {}): Promise<T> {
  try {
    // Clean endpoint
    const cleanEndpoint = endpoint.startsWith("/api") ? endpoint.substring(4) : endpoint;

    // Construct the full URL
    const fullUrl = buildFullUrl(cleanEndpoint);

    // Detect FormData to avoid setting Content-Type (browser sets multipart/form-data with boundary)
    const isFormData = options.body instanceof FormData;

    // Build headers - normalize and handle Content-Type properly for FormData
    // NOTE: We do NOT add If-None-Match headers; the browser handles ETag revalidation automatically
    // Normalize headers to support Headers instances, [string, string][] tuples, and plain objects
    const headersObj = new Headers(options.headers as HeadersInit | undefined);
    headersObj.set("Accept", "application/json");

    if (isFormData) {
      // For FormData, remove any Content-Type header to let browser set multipart/form-data with boundary
      headersObj.delete("Content-Type");
    } else if (!headersObj.has("Content-Type")) {
      // Only set Content-Type if not already provided
      headersObj.set("Content-Type", "application/json");
    }

    const headers: Record<string, string> = Object.fromEntries(headersObj.entries());

    // Make the request with timeout
    // NOTE: Increased to 20s due to database performance issues with large DELETE operations
    // Root cause: Sequential scan on crawled_pages table when deleting sources with 7K+ rows
    // takes 13+ seconds. This is a temporary fix until we implement batch deletion.
    // See: DELETE FROM archon_crawled_pages WHERE source_id = '9529d5dabe8a726a' (7,073 rows)
    const response = await fetch(fullUrl, {
      ...options,
      headers,
      signal: options.signal ?? AbortSignal.timeout(20000), // 20 second timeout (was 10s)
    });

    // Handle errors
    if (!response.ok) {
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
      throw new APIServiceError(errorMessage, "HTTP_ERROR", response.status);
    }

    // Handle 204 No Content (DELETE operations)
    if (response.status === 204) {
      return undefined as T;
    }

    // Parse response data
    const result = await response.json();

    // Check for API errors
    if (result.error) {
      throw new APIServiceError(result.error, "API_ERROR", response.status);
    }

    return result as T;
  } catch (error) {
    if (error instanceof APIServiceError) {
      throw error;
    }

    throw new APIServiceError(
      `Failed to call API ${endpoint}: ${error instanceof Error ? error.message : "Unknown error"}`,
      "NETWORK_ERROR",
      500,
    );
  }
}
