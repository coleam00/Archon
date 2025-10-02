/**
 * Unified API Configuration
 * 
 * This module provides centralized configuration for API endpoints
 * and handles different environments (development, Docker, production)
 */

// Get the API URL from environment or use relative URLs for proxy
export function getApiUrl(): string {
  // Check if VITE_API_URL is explicitly provided (for absolute URL mode)
  const viteApiUrl = (import.meta.env as any).VITE_API_URL as string | undefined;
  if (viteApiUrl) {
    return viteApiUrl;
  }

  // Default to relative URLs to use Vite proxy in development
  // or direct proxy in production - this ensures all requests go through proxy
  return '';
}

// Get the base path for API endpoints
export function getApiBasePath(): string {
  const apiUrl = getApiUrl();
  
  // If using relative URLs (empty string), just return /api
  if (!apiUrl) {
    return '/api';
  }
  
  // Otherwise, append /api to the base URL
  return `${apiUrl}/api`;
}

// Export commonly used values
export const API_BASE_URL = '/api';  // Always use relative URL for API calls
export const API_FULL_URL = getApiUrl();
