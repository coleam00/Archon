/**
 * Shared API utilities for project features
 * Project-specific API functions and utilities
 */

import { APIServiceError } from "../../shared/errors";

// API configuration - use relative URL to go through Vite proxy
const API_BASE_URL = "/api";

// Helper function to call FastAPI endpoints directly
export async function callAPI<T = unknown>(endpoint: string, options: RequestInit = {}): Promise<T> {
  try {
    // Remove /api prefix if it exists since API_BASE_URL already includes it
    const cleanEndpoint = endpoint.startsWith("/api") ? endpoint.substring(4) : endpoint;
    const response = await fetch(`${API_BASE_URL}${cleanEndpoint}`, {
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
      ...options,
      signal: options.signal ?? AbortSignal.timeout(10000), // 10 second timeout
    });

    if (!response.ok) {
      // Try to get error details from response body
      let errorMessage = `HTTP error! status: ${response.status}`;
      try {
        const errorBody = await response.text();
        if (errorBody) {
          const errorJson = JSON.parse(errorBody);
          errorMessage = errorJson.detail || errorJson.error || errorMessage;
        }
      } catch (_e) {
        // Ignore parse errors, use default message
      }

      throw new APIServiceError(errorMessage, "HTTP_ERROR", response.status);
    }

    // Handle 204 No Content responses (common for DELETE operations)
    if (response.status === 204) {
      return undefined as T;
    }

    const result = await response.json();

    // Check if response has error field (from FastAPI error format)
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

// Utility function for relative time formatting
export function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diffInSeconds < 60) return "just now";
  if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)} minutes ago`;
  if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)} hours ago`;
  if (diffInSeconds < 604800) return `${Math.floor(diffInSeconds / 86400)} days ago`;

  return `${Math.floor(diffInSeconds / 604800)} weeks ago`;
}
