/**
 * Unified API Configuration
 * 
 * This module provides centralized configuration for API endpoints
 * and handles different environments (development, Docker, production)
 */

// Get the API URL from environment or use relative URLs for proxy
export function getApiUrl(): string {
  let apiUrl = '';
  
  // Check if VITE_API_URL is provided (set by docker-compose or production)
  if (import.meta.env.VITE_API_URL) {
    apiUrl = import.meta.env.VITE_API_URL;
  }
  // For production, use relative URLs (goes through proxy)
  else if (import.meta.env.PROD) {
    return '';
  }
  // For development, construct from window location
  else {
    const protocol = window.location.protocol;
    const host = window.location.hostname;
    // Use configured port or default to 8181
    const port = import.meta.env.VITE_ARCHON_SERVER_PORT || '8181';
    
    if (!import.meta.env.VITE_ARCHON_SERVER_PORT) {
      console.info('[Archon] Using default ARCHON_SERVER_PORT: 8181');
    }
    
    apiUrl = `${protocol}//${host}:${port}`;
  }
  
  // Ensure HTTPS protocol if current page is HTTPS (prevents mixed content errors)
  if (window.location.protocol === 'https:' && apiUrl.startsWith('http:')) {
    // Check if there's a specific HTTPS API URL configured
    if (import.meta.env.VITE_API_URL_HTTPS) {
      apiUrl = import.meta.env.VITE_API_URL_HTTPS;
    } else {
      // Convert HTTP to HTTPS and handle port appropriately
      apiUrl = apiUrl.replace('http:', 'https:');
      
      // If the URL has a non-standard port (not 80), check if we should use standard HTTPS port
      const url = new URL(apiUrl);
      if (url.port === '8181' || url.port === '80') {
        // For common development/HTTP ports, try standard HTTPS port first
        const httpsPort = import.meta.env.VITE_API_HTTPS_PORT || '443';
        url.port = httpsPort;
        apiUrl = url.toString();
      }
    }
  }
  
  return apiUrl;
}

// Get the base path for API endpoints
export function getApiBasePath(): string {
  const apiUrl = getApiUrl();
  
  // If using relative URLs (empty string), just return /api
  if (!apiUrl) {
    return '/api';
  }
  
  // For production with VITE_API_URL set, return the URL as-is
  // The backend already handles /api routes, so no need to append /api
  return apiUrl;
}

// Export commonly used values
export const API_BASE_URL = '/api';  // Always use relative URL for API calls
export const API_FULL_URL = getApiUrl();
