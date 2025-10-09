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
    
    // CRITICAL FIX: In production with nginx proxy, don't add port number
    // Check if we're running behind a proxy (HTTPS on standard port or specific host)
    const isProxied = (
      // Running on HTTPS with standard port (443) - likely behind proxy
      (protocol === 'https:' && (window.location.port === '' || window.location.port === '443')) ||
      // Running on the production domain - definitely behind proxy
      host.includes('prometheusags.ai') ||
      // Check if HOST env var indicates production setup
      (import.meta.env.VITE_HOST && import.meta.env.VITE_HOST.includes('prometheusags.ai'))
    );
    
    if (isProxied) {
      // For production/proxy setup, use the current domain without port
      // The nginx proxy will handle routing /api/* to the correct backend port
      apiUrl = `${protocol}//${host}`;
    } else {
      // For local development, use configured port or default to 8181
      const port = import.meta.env.VITE_ARCHON_SERVER_PORT || '8181';
      
      if (!import.meta.env.VITE_ARCHON_SERVER_PORT) {
        console.info('[Archon] Using default ARCHON_SERVER_PORT: 8181');
      }
      
      apiUrl = `${protocol}//${host}:${port}`;
    }
  }
  
  // Ensure HTTPS protocol if current page is HTTPS (prevents mixed content errors)
  if (window.location.protocol === 'https:' && apiUrl.startsWith('http:')) {
    // Check if there's a specific HTTPS API URL configured
    if (import.meta.env.VITE_API_URL_HTTPS) {
      apiUrl = import.meta.env.VITE_API_URL_HTTPS;
    } else {
      // Convert HTTP to HTTPS
      apiUrl = apiUrl.replace('http:', 'https:');
      
      // For production domains, remove non-standard ports when converting to HTTPS
      const url = new URL(apiUrl);
      if (url.hostname.includes('prometheusags.ai') && (url.port === '8181' || url.port === '80')) {
        url.port = ''; // Use standard HTTPS port (443)
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
