/**
 * MCP Configuration Helper
 * 
 * Centralizes MCP server configuration based on environment variables
 * Supports both local development and LAN deployment modes
 */

export interface MCPConfig {
  host: string;
  port: number;
  protocol: string;
  useProxy: boolean;
  url: string;
  transport: 'sse' | 'http';
}

/**
 * Get MCP configuration from environment variables
 * 
 * Environment variables:
 * - VITE_MCP_HOST: The MCP server hostname (default: 'localhost')
 * - VITE_MCP_PROTOCOL: Protocol to use - http or https (default: 'http')
 * - VITE_MCP_USE_PROXY: Whether to route through proxy (default: 'false')
 * - VITE_MCP_PORT: The MCP server port (default: '8051')
 * 
 * @returns MCPConfig object with all configuration values
 */
export function getMCPConfig(): MCPConfig {
  const host = import.meta.env.VITE_MCP_HOST || 'localhost';
  const protocol = import.meta.env.VITE_MCP_PROTOCOL || 'http';
  const useProxy = import.meta.env.VITE_MCP_USE_PROXY === 'true';
  const port = import.meta.env.VITE_MCP_PORT || '8051';
  
  // If using proxy, use relative path that goes through Traefik
  // This allows the browser to automatically use the current domain
  const url = useProxy 
    ? '/mcp'
    : `${protocol}://${host}:${port}/mcp`;
  
  return {
    host,
    port: parseInt(port),
    protocol,
    useProxy,
    url,
    transport: 'sse'
  };
}

/**
 * Get the full MCP URL for third-party clients
 * This is the external URL that third-party MCP clients should use
 * 
 * @returns The full external MCP URL
 */
export function getExternalMCPUrl(): string {
  const config = getMCPConfig();
  
  // If using proxy, construct the full external URL
  if (config.useProxy) {
    return `${config.protocol}://${config.host}/mcp`;
  }
  
  // Otherwise, use the direct connection URL
  return `${config.protocol}://${config.host}:${config.port}/mcp`;
}

/**
 * Check if MCP is configured for LAN deployment
 * 
 * @returns true if configured for LAN deployment, false for local
 */
export function isLANDeployment(): boolean {
  return import.meta.env.VITE_MCP_USE_PROXY === 'true';
}