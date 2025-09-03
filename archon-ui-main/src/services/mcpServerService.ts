import { z } from 'zod';

export interface ServerStatus {
  status: 'running' | 'starting' | 'stopped' | 'stopping';
  uptime: number | null;
  logs: string[];
}

export interface ServerResponse {
  success: boolean;
  status: string;
  message: string;
}

export interface ServerConfig {
  transport: string;
  host: string;
  port: number;
  model?: string;
}

// Zod schemas for MCP protocol
const MCPParameterSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  type: z.string().optional(),
});

const MCPToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.object({
    type: z.literal('object'),
    properties: z.record(z.any()).optional(),
    required: z.array(z.string()).optional(),
  }).optional(),
});

const MCPToolsListResponseSchema = z.object({
  tools: z.array(MCPToolSchema),
});

const MCPResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  result: z.any().optional(),
  error: z.object({
    code: z.number(),
    message: z.string(),
    data: z.any().optional(),
  }).optional(),
});

export type MCPTool = z.infer<typeof MCPToolSchema>;
export type MCPParameter = z.infer<typeof MCPParameterSchema>;


/**
 * MCP Server Service - Handles the Archon MCP server lifecycle via FastAPI
 */
class MCPServerService {
  private baseUrl = ''; // Use relative URL to go through Vite proxy

  // ========================================
  // SERVER MANAGEMENT
  // ========================================

  async startServer(): Promise<ServerResponse> {
    const response = await fetch(`${this.baseUrl}/api/mcp/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to start MCP server');
    }

    return response.json();
  }

  async stopServer(): Promise<ServerResponse> {
    const response = await fetch(`${this.baseUrl}/api/mcp/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to stop MCP server');
    }

    return response.json();
  }

  async getStatus(): Promise<ServerStatus> {
    const response = await fetch(`${this.baseUrl}/api/mcp/status`);

    if (!response.ok) {
      throw new Error('Failed to get server status');
    }

    return response.json();
  }

  async getConfiguration(): Promise<ServerConfig> {
    const response = await fetch(`${this.baseUrl}/api/mcp/config`);

    if (!response.ok) {
      // Return default config if endpoint doesn't exist yet
      return {
        transport: 'sse',
        host: 'localhost',
        port: 8051
      };
    }

    return response.json();
  }

  async updateConfiguration(config: Partial<ServerConfig>): Promise<ServerResponse> {
    const response = await fetch(`${this.baseUrl}/api/mcp/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to update configuration');
    }

    return response.json();
  }


  // ========================================
  // LEGACY ARCHON TOOL ACCESS (For backward compatibility)
  // ========================================

  /**
   * Make an MCP call to the running Archon server via SSE
   */
  private async makeMCPCall(method: string, params?: any): Promise<any> {
    const status = await this.getStatus();
    if (status.status !== 'running') {
      throw new Error('MCP server is not running');
    }

    const config = await this.getConfiguration();
    const mcpUrl = `http://${config.host}:${config.port}/${config.transport}`;
    
    // Generate unique request ID
    const id = Math.random().toString(36).substring(2);
    
    const mcpRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params: params || {}
    };

    try {
      const response = await fetch(mcpUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(mcpRequest)
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const mcpResponse = await response.json();
      
      // Validate MCP response format
      const validatedResponse = MCPResponseSchema.parse(mcpResponse);
      
      if (validatedResponse.error) {
        throw new Error(`MCP Error: ${validatedResponse.error.message}`);
      }

      return validatedResponse.result;
    } catch (error) {
      console.error('MCP call failed:', error);
      throw error;
    }
  }

  /**
   * Get available tools from the running Archon MCP server
   * @deprecated Use mcpClientService for tool discovery instead
   */
  async getAvailableTools(): Promise<MCPTool[]> {
    try {
      console.log('Attempting direct MCP tools/list call to Archon server...');
      const result = await this.makeMCPCall('tools/list');
      const validatedResult = MCPToolsListResponseSchema.parse(result);
      console.log('Successfully retrieved tools from Archon server:', validatedResult.tools.length);
      return validatedResult.tools;
    } catch (mcpError) {
      console.warn('Direct MCP call to Archon server failed:', mcpError);
      throw new Error(`Failed to retrieve tools from Archon server: ${mcpError instanceof Error ? mcpError.message : mcpError}`);
    }
  }

  /**
   * Call a specific tool on the Archon MCP server
   * @deprecated Use mcpClientService for tool calls instead
   */
  async callTool(name: string, arguments_: Record<string, any>): Promise<any> {
    try {
      const result = await this.makeMCPCall('tools/call', {
        name,
        arguments: arguments_
      });
      return result;
    } catch (error) {
      console.error(`Failed to call Archon MCP tool ${name}:`, error);
      throw error;
    }
  }
}

export const mcpServerService = new MCPServerService();

/**
 * Legacy function - use mcpServerService.getAvailableTools() instead
 * @deprecated Use mcpServerService.getAvailableTools() or mcpClientService instead
 */
export const getMCPTools = async () => {
  console.warn('getMCPTools is deprecated. Use mcpServerService.getAvailableTools() or mcpClientService instead.');
  return mcpServerService.getAvailableTools();
}; 