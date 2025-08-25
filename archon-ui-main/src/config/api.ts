/**
 * Unified API Configuration
 * 
 * This module provides centralized configuration for API endpoints
 * and handles different environments (development, Docker, production)
 */

// Get the API URL from environment or construct it
export function getApiUrl(): string {
  // Debug logging
  console.log('[API Config] Environment check:', {
    DOCKER_ENV: import.meta.env.DOCKER_ENV,
    PROD: import.meta.env.PROD,
    VITE_API_URL: import.meta.env.VITE_API_URL,
    MODE: import.meta.env.MODE
  });

  // For Docker environment, always use relative URL (goes through Vite proxy)
  if (import.meta.env.DOCKER_ENV === 'true') {
    console.log('[API Config] Using Docker environment - relative URLs');
    return '';
  }

  // For relative URLs in production (goes through proxy)
  if (import.meta.env.PROD) {
    console.log('[API Config] Using production environment - relative URLs');
    return '';
  }

  // Check if VITE_API_URL is provided (set by docker-compose)
  if (import.meta.env.VITE_API_URL) {
    console.log('[API Config] Using VITE_API_URL:', import.meta.env.VITE_API_URL);
    return import.meta.env.VITE_API_URL;
  }

  // For local development only, construct from window location
  const protocol = window.location.protocol;
  const host = window.location.hostname;
  // Use configured port or default to 8181
  const port = import.meta.env.VITE_ARCHON_SERVER_PORT || '8181';
  
  console.log('[API Config] Using local development URL:', `${protocol}//${host}:${port}`);
  
  return `${protocol}//${host}:${port}`;
}

// Get the base path for API endpoints
export function getApiBasePath(): string {
  const apiUrl = getApiUrl();
  
  // If using relative URLs (empty string), just return /api
  if (!apiUrl) {
    console.log('[API Config] Using relative API path: /api');
    return '/api';
  }
  
  // Otherwise, append /api to the base URL
  console.log('[API Config] Using full API path:', `${apiUrl}/api`);
  return `${apiUrl}/api`;
}

// Get WebSocket URL for real-time connections
export function getWebSocketUrl(): string {
  const apiUrl = getApiUrl();
  
  // If using relative URLs, construct from current location
  if (!apiUrl) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    return `${protocol}//${host}`;
  }
  
  // Convert http/https to ws/wss
  return apiUrl.replace(/^http/, 'ws');
}

// Export commonly used values
export const API_BASE_URL = '/api';  // Always use relative URL for API calls
export const API_FULL_URL = getApiUrl();
export const WS_URL = getWebSocketUrl();
