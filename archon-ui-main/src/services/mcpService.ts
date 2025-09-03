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

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

export interface ServerConfig {
  transport: string;
  host: string;
  port: number;
  model?: string;
}

// Multi-client interfaces
export interface MCPClientConfig {
  name: string;
  transport_type: 'sse' | 'stdio' | 'docker' | 'npx';
  connection_config: Record<string, any>;
  auto_connect?: boolean;
  health_check_interval?: number;
  is_default?: boolean;
}

export interface MCPClient {
  id: string;
  name: string;
  transport_type: 'sse' | 'stdio' | 'docker' | 'npx';
  connection_config: Record<string, any>;
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  auto_connect: boolean;
  health_check_interval: number;
  last_seen: string | null;
  last_error: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface MCPClientTool {
  id: string;
  client_id: string;
  tool_name: string;
  tool_description: string | null;
  tool_schema: Record<string, any>;
  discovered_at: string;
}

export interface ToolCallRequest {
  client_id: string;
  tool_name: string;
  arguments: Record<string, any>;
}

interface StreamLogOptions {
  autoReconnect?: boolean;
  reconnectDelay?: number;
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


class MCPService {
  private baseUrl = ''; // Use relative URL to go through Vite proxy

  // ========================================
  // SERVER MANAGEMENT (Original functionality)
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

  async getLogs(options: { limit?: number } = {}): Promise<LogEntry[]> {
    const params = new URLSearchParams();
    if (options.limit) {
      params.append('limit', options.limit.toString());
    }

    const response = await fetch(`${this.baseUrl}/api/mcp/logs?${params}`);

    if (!response.ok) {
      throw new Error('Failed to fetch logs');
    }

    const data = await response.json();
    return data.logs || [];
  }

  async clearLogs(): Promise<ServerResponse> {
    const response = await fetch(`${this.baseUrl}/api/mcp/logs`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!response.ok) {
      throw new Error('Failed to clear logs');
    }

    return response.json();
  }


  // ========================================
  // CLIENT MANAGEMENT (New functionality)
  // ========================================

  /**
   * Get all configured MCP clients
   */
  async getClients(): Promise<MCPClient[]> {
    const response = await fetch(`${this.baseUrl}/api/mcp/clients/`);

    if (!response.ok) {
      throw new Error('Failed to get MCP clients');
    }

    return response.json();
  }

  /**
   * Create a new MCP client
   */
  async createClient(config: MCPClientConfig): Promise<MCPClient> {
    const response = await fetch(`${this.baseUrl}/api/mcp/clients/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to create MCP client');
    }

    return response.json();
  }

  /**
   * Get a specific MCP client
   */
  async getClient(clientId: string): Promise<MCPClient> {
    const response = await fetch(`${this.baseUrl}/api/mcp/clients/${clientId}`);

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to get MCP client');
    }

    return response.json();
  }

  /**
   * Update an MCP client
   */
  async updateClient(clientId: string, updates: Partial<MCPClientConfig>): Promise<MCPClient> {
    const response = await fetch(`${this.baseUrl}/api/mcp/clients/${clientId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to update MCP client');
    }

    return response.json();
  }

  /**
   * Delete an MCP client
   */
  async deleteClient(clientId: string): Promise<{ success: boolean; message: string }> {
    const response = await fetch(`${this.baseUrl}/api/mcp/clients/${clientId}`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to delete MCP client');
    }

    return response.json();
  }

  /**
   * Connect to an MCP client
   */
  async connectClient(clientId: string): Promise<{ success: boolean; message: string }> {
    const response = await fetch(`${this.baseUrl}/api/mcp/clients/${clientId}/connect`, {
      method: 'POST'
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to connect to MCP client');
    }

    return response.json();
  }

  /**
   * Disconnect from an MCP client
   */
  async disconnectClient(clientId: string): Promise<{ success: boolean; message: string }> {
    const response = await fetch(`${this.baseUrl}/api/mcp/clients/${clientId}/disconnect`, {
      method: 'POST'
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to disconnect from MCP client');
    }

    return response.json();
  }

  /**
   * Get client status and health
   */
  async getClientStatus(clientId: string): Promise<{
    client_id: string;
    status: string;
    last_seen: string | null;
    last_error: string | null;
    is_active: boolean;
  }> {
    const response = await fetch(`${this.baseUrl}/api/mcp/clients/${clientId}/status`);

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to get client status');
    }

    return response.json();
  }

  /**
   * Get tools from a specific client
   */
  async getClientTools(clientId: string): Promise<{
    client_id: string;
    tools: MCPClientTool[];
    count: number;
  }> {
    const response = await fetch(`${this.baseUrl}/api/mcp/clients/${clientId}/tools`);

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to get client tools');
    }

    return response.json();
  }

  /**
   * Test a client configuration before saving
   */
  async testClientConfig(config: MCPClientConfig): Promise<{ success: boolean; message: string }> {
    const response = await fetch(`${this.baseUrl}/api/mcp/clients/test-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to test client configuration');
    }

    return response.json();
  }

  /**
   * Call a tool on a specific client
   */
  async callClientTool(request: ToolCallRequest): Promise<any> {
    const response = await fetch(`${this.baseUrl}/api/mcp/clients/tools/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to call client tool');
    }

    return response.json();
  }

  // ========================================
  // LEGACY TOOL FUNCTIONALITY (Updated for multi-client)
  // ========================================

  /**
   * Make an MCP call to the running server via SSE
   */
  private async makeMCPCall(method: string, params?: any): Promise<any> {
    const status = await this.getStatus();
    if (status.status !== 'running') {
      throw new Error('MCP server is not running');
    }

    const config = await this.getConfiguration();
    const mcpUrl = `http://${config.host}:${config.port}/mcp`;
    
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
   * Get available tools from the running MCP server (legacy - for Archon default client)
   */
  async getAvailableTools(): Promise<MCPTool[]> {
    try {
      // Skip the broken backend endpoint and try direct MCP protocol call
      console.log('Attempting direct MCP tools/list call...');
      const result = await this.makeMCPCall('tools/list');
      const validatedResult = MCPToolsListResponseSchema.parse(result);
      console.log('Successfully retrieved tools via MCP protocol:', validatedResult.tools.length);
      return validatedResult.tools;
    } catch (mcpError) {
      console.warn('Direct MCP call failed, falling back to backend endpoint:', mcpError);
      
      // Fallback to backend endpoint (which returns debug placeholder)
      try {
        const response = await fetch(`${this.baseUrl}/api/mcp/tools`);
        
        if (response.ok) {
          const data = await response.json();
          console.log('Backend endpoint returned:', data);
          
          // If we only get the debug placeholder, return empty array with warning
          if (data.tools.length === 1 && data.tools[0].name === 'debug_placeholder') {
            console.warn('Backend returned debug placeholder - MCP tool introspection is not working');
            // Return empty array instead of the placeholder
            return [];
          }
          
          // Convert the backend format to MCP tool format
          const tools: MCPTool[] = data.tools.map((tool: any) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: {
              type: 'object' as const,
              properties: tool.parameters.reduce((props: any, param: any) => {
                props[param.name] = {
                  type: param.type,
                  description: param.description
                };
                return props;
              }, {}),
              required: tool.parameters.filter((p: any) => p.required).map((p: any) => p.name)
            }
          }));
          return tools;
        }
        throw new Error('Backend endpoint failed');
      } catch (backendError) {
        console.error('Both MCP protocol and backend endpoint failed:', { mcpError, backendError });
        throw new Error(`Failed to retrieve tools: MCP protocol failed (${mcpError instanceof Error ? mcpError.message : mcpError}), backend also failed (${backendError instanceof Error ? backendError.message : backendError})`);
      }
    }
  }

  /**
   * Call a specific MCP tool (legacy - for Archon default client)
   */
  async callTool(name: string, arguments_: Record<string, any>): Promise<any> {
    try {
      const result = await this.makeMCPCall('tools/call', {
        name,
        arguments: arguments_
      });
      return result;
    } catch (error) {
      console.error(`Failed to call MCP tool ${name}:`, error);
      throw error;
    }
  }

  /**
   * Get aggregated tools from all connected clients
   */
  async getAllAvailableTools(): Promise<{
    archon_tools: MCPTool[];
    client_tools: { client: MCPClient; tools: MCPClientTool[] }[];
    total_count: number;
  }> {
    try {
      // Get Archon tools (default client)
      const archonTools = await this.getAvailableTools();
      
      // Get all clients and their tools
      const clients = await this.getClients();
      const clientTools = await Promise.all(
        clients
          .filter(client => client.status === 'connected' && !client.is_default)
          .map(async (client) => {
            try {
              const toolsData = await this.getClientTools(client.id);
              return { client, tools: toolsData.tools };
            } catch {
              return { client, tools: [] };
            }
          })
      );

      const totalCount = archonTools.length + clientTools.reduce((sum, ct) => sum + ct.tools.length, 0);

      return {
        archon_tools: archonTools,
        client_tools: clientTools,
        total_count: totalCount
      };
    } catch (error) {
      console.error('Failed to get all available tools:', error);
      throw error;
    }
  }
}

export const mcpService = new MCPService();

/**
 * Legacy function - replaced by mcpService.getAvailableTools()
 * @deprecated Use mcpService.getAvailableTools() instead
 */
export const getMCPTools = async () => {
  console.warn('getMCPTools is deprecated. Use mcpService.getAvailableTools() instead.');
  return mcpService.getAvailableTools();
}; 