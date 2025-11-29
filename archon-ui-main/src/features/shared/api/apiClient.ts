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
 * Simple API call function for JSON APIs
 * Browser automatically handles ETags/304s through its HTTP cache
 *
 * NOTE: This wrapper is designed for JSON-only API calls.
 * For file uploads or FormData requests, use fetch() directly.
 */
export async function callAPIWithETag<T = unknown>(endpoint: string, options: RequestInit = {}): Promise<T> {
  try {
    // Handle absolute URLs (direct service connections)
    const isAbsoluteUrl = endpoint.startsWith("http://") || endpoint.startsWith("https://");

    let fullUrl: string;
    if (isAbsoluteUrl) {
      // Use absolute URL as-is (for direct service connections)
      fullUrl = endpoint;
    } else {
      // Clean endpoint and build relative URL
      const cleanEndpoint = endpoint.startsWith("/api") ? endpoint.substring(4) : endpoint;
      fullUrl = buildFullUrl(cleanEndpoint);
    }

    // Build headers - only set Content-Type for requests with a body
    // NOTE: We do NOT add If-None-Match headers; the browser handles ETag revalidation automatically
    //
    // Currently assumes headers are passed as plain objects (Record<string, string>)
    // which works for all our current usage. The API doesn't require Accept headers
    // since it always returns JSON, and we only set Content-Type when sending data.
    const headers: Record<string, string> = {
      ...((options.headers as Record<string, string>) || {}),
    };

    // Only set Content-Type for requests that have a body (POST, PUT, PATCH, etc.)
    // GET and DELETE requests should not have Content-Type header
    const _method = options.method?.toUpperCase() || "GET";
    const hasBody = options.body !== undefined && options.body !== null;
    if (hasBody && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    // Make the request with method-specific timeout
    // DELETE operations need extended timeout for large dataset deletions with batch processing
    // Large sources (docs with 10K+ pages) require batch deletion across
    // multiple tables (archon_crawled_pages, archon_code_examples, archon_page_metadata)
    // which can take 30-60 seconds even with 500-row batches. The 320s timeout provides
    // ample buffer for very large sources while preventing indefinite hangs.
    const method = options.method?.toUpperCase() || "GET";
    const timeoutMs = method === "DELETE" ? 320000 : 20000; // 320s for DELETE, 20s for others
    
    const response = await fetch(fullUrl, {
      ...options,
      headers,
      signal: options.signal ?? AbortSignal.timeout(timeoutMs),
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
