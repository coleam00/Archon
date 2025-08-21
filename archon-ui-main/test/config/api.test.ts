/**
 * Tests for API configuration port requirements
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('API Configuration', () => {
  let originalEnv: any;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...import.meta.env };
    
    // Clear the module cache to ensure fresh imports
    vi.resetModules();
  });

  afterEach(() => {
    // Restore original environment
    Object.keys(import.meta.env).forEach(key => {
      delete (import.meta.env as any)[key];
    });
    Object.assign(import.meta.env, originalEnv);
  });

  describe('getApiUrl', () => {
    it('should use VITE_API_URL when provided', async () => {
      // Set VITE_API_URL
      (import.meta.env as any).VITE_API_URL = 'http://custom-api:9999';
      
      const { getApiUrl } = await import('../../src/config/api');
      expect(getApiUrl()).toBe('http://custom-api:9999');
    });

    it('should return empty string in production mode', async () => {
      // Set production mode
      (import.meta.env as any).PROD = true;
      delete (import.meta.env as any).VITE_API_URL;
      
      const { getApiUrl } = await import('../../src/config/api');
      expect(getApiUrl()).toBe('');
    });

    it('should throw error when ARCHON_SERVER_PORT is not set in development', async () => {
      // Development mode without port
      delete (import.meta.env as any).PROD;
      delete (import.meta.env as any).VITE_API_URL;
      delete (import.meta.env as any).ARCHON_SERVER_PORT;
      
      // The error will be thrown during module import because API_FULL_URL calls getApiUrl()
      await expect(async () => {
        await import('../../src/config/api');
      }).rejects.toThrow('ARCHON_SERVER_PORT environment variable is required');
    });

    it('should use ARCHON_SERVER_PORT when set in development', async () => {
      // Development mode with custom port
      delete (import.meta.env as any).PROD;
      delete (import.meta.env as any).VITE_API_URL;
      (import.meta.env as any).ARCHON_SERVER_PORT = '9191';
      
      // Mock window.location
      Object.defineProperty(window, 'location', {
        value: {
          protocol: 'http:',
          hostname: 'localhost'
        },
        writable: true
      });
      
      const { getApiUrl } = await import('../../src/config/api');
      expect(getApiUrl()).toBe('http://localhost:9191');
    });

    it('should use custom port with https protocol', async () => {
      // Development mode with custom port and https
      delete (import.meta.env as any).PROD;
      delete (import.meta.env as any).VITE_API_URL;
      (import.meta.env as any).ARCHON_SERVER_PORT = '8443';
      
      // Mock window.location with https
      Object.defineProperty(window, 'location', {
        value: {
          protocol: 'https:',
          hostname: 'example.com'
        },
        writable: true
      });
      
      const { getApiUrl } = await import('../../src/config/api');
      expect(getApiUrl()).toBe('https://example.com:8443');
    });
  });

  describe('getWebSocketUrl', () => {
    it('should convert http to ws', async () => {
      (import.meta.env as any).VITE_API_URL = 'http://localhost:8181';
      
      const { getWebSocketUrl } = await import('../../src/config/api');
      expect(getWebSocketUrl()).toBe('ws://localhost:8181');
    });

    it('should convert https to wss', async () => {
      (import.meta.env as any).VITE_API_URL = 'https://secure.example.com:8443';
      
      const { getWebSocketUrl } = await import('../../src/config/api');
      expect(getWebSocketUrl()).toBe('wss://secure.example.com:8443');
    });

    it('should handle production mode with https', async () => {
      (import.meta.env as any).PROD = true;
      delete (import.meta.env as any).VITE_API_URL;
      
      // Mock window.location
      Object.defineProperty(window, 'location', {
        value: {
          protocol: 'https:',
          host: 'app.example.com'
        },
        writable: true
      });
      
      const { getWebSocketUrl } = await import('../../src/config/api');
      expect(getWebSocketUrl()).toBe('wss://app.example.com');
    });
  });

  describe('Port validation', () => {
    it('should handle various port formats', async () => {
      const testCases = [
        { port: '80', expected: 'http://localhost:80' },
        { port: '443', expected: 'http://localhost:443' },
        { port: '3000', expected: 'http://localhost:3000' },
        { port: '8080', expected: 'http://localhost:8080' },
        { port: '65535', expected: 'http://localhost:65535' },
      ];

      for (const { port, expected } of testCases) {
        vi.resetModules();
        delete (import.meta.env as any).PROD;
        delete (import.meta.env as any).VITE_API_URL;
        (import.meta.env as any).ARCHON_SERVER_PORT = port;
        
        Object.defineProperty(window, 'location', {
          value: {
            protocol: 'http:',
            hostname: 'localhost'
          },
          writable: true
        });
        
        const { getApiUrl } = await import('../../src/config/api');
        expect(getApiUrl()).toBe(expected);
      }
    });
  });
});

// MCP Client Service Configuration tests removed - service not currently in use