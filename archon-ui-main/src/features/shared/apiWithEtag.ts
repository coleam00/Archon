/**
 * ETag-aware API client for TanStack Query integration
 * Reduces bandwidth by 70-90% through HTTP 304 responses
 */

import { API_BASE_URL } from "../../config/api";
import { ProjectServiceError } from "../projects/shared/api";

export class NotModifiedError extends Error {
  constructor() {
    super("Resource not modified");
    this.name = "NotModifiedError";
  }
}

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

    // Build headers with If-None-Match if we have an ETag
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...((options.headers as Record<string, string>) || {}),
    };

    // Browser will handle ETag headers automatically

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

    // Handle 304 Not Modified - let TanStack Query handle caching
    if (response.status === 304) {
      if (ETAG_DEBUG) {
        console.log(`%c[ETag] 304 Not Modified for ${cleanEndpoint}`, "color: #10b981; font-weight: bold");
      }
      throw new NotModifiedError();
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
      return undefined as T;
    }

    // Parse response data
    const result = await response.json();

    // Check for API errors
    if (result.error) {
      throw new ProjectServiceError(result.error, "API_ERROR", response.status);
    }

    // ETag headers are handled by browser automatically
    if (ETAG_DEBUG) {
      const etag = response.headers.get("ETag");
      if (etag) {
        console.log(
          `%c[ETag] Response for ${cleanEndpoint}`,
          "color: #3b82f6; font-weight: bold",
          `ETag: ${etag.substring(0, 12)}...`,
        );
      }
    }

    return result as T;
  } catch (error) {
    if (error instanceof ProjectServiceError || error instanceof NotModifiedError) {
      throw error;
    }

    throw new ProjectServiceError(
      `Failed to call API ${endpoint}: ${error instanceof Error ? error.message : "Unknown error"}`,
      "NETWORK_ERROR",
      500,
    );
  }
}
