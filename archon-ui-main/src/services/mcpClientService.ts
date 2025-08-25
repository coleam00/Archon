import { z } from 'zod';
import { getApiUrl } from '../config/api';

// ========================================
// TYPES & INTERFACES
// ========================================

export interface MCPClientConfig {
  name: string;
  transport_type: 'http';  // Only Streamable HTTP is supported for MCP clients
  connection_config: {
    url: string;  // The Streamable HTTP endpoint URL (e.g., http://localhost:8051/mcp)
  };
  auto_connect?: boolean;
  health_check_interval?: number;
  is_default?: boolean;
}

export interface MCPClient {
  id: string;
  name: string;
  transport_type: 'http';  // Only Streamable HTTP is supported
  connection_config: {
    url: string;
  };
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

export interface ClientStatus {
  client_id: string;
  status: string;
  last_seen: string | null;
  last_error: string | null;
  is_active: boolean;
}

export interface ToolsResponse {
  client_id: string;
  tools: MCPClientTool[];
  count: number;
}

export interface AllToolsResponse {
  archon_tools: MCPTool[];
  client_tools: { client: MCPClient; tools: MCPClientTool[] }[];
  total_count: number;
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

export type MCPTool = z.infer<typeof MCPToolSchema>;
export type MCPParameter = z.infer<typeof MCPParameterSchema>;

/**
 * MCP Client Service - Universal MCP client that connects to any MCP servers
 * This service communicates with the standalone Python MCP client service
 */
export class MCPClientService {
  private baseUrl = getApiUrl();

  // ========================================
  // CLIENT MANAGEMENT
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

  // ========================================
  // CONNECTION MANAGEMENT
  // ========================================

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
  async getClientStatus(clientId: string): Promise<ClientStatus> {
    const response = await fetch(`${this.baseUrl}/api/mcp/clients/${clientId}/status`);

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to get client status');
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

  // ========================================
  // TOOL DISCOVERY & EXECUTION
  // ========================================

  /**
   * Get tools from a specific client
   */
  async getClientTools(clientId: string): Promise<ToolsResponse> {
    const response = await fetch(`${this.baseUrl}/api/mcp/clients/${clientId}/tools`);

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to get client tools');
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

  /**
   * Get tools from all connected clients (including Archon via MCP client)
   */
  async getAllAvailableTools(): Promise<AllToolsResponse> {
    const response = await fetch(`${this.baseUrl}/api/mcp/clients/tools/all`);

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to get all available tools');
    }

    return response.json();
  }

  /**
   * Discover tools from a specific client (force refresh)
   */
  async discoverClientTools(clientId: string): Promise<ToolsResponse> {
    const response = await fetch(`${this.baseUrl}/api/mcp/clients/${clientId}/tools/discover`, {
      method: 'POST'
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to discover client tools');
    }

    return response.json();
  }

  // ========================================
  // CONVENIENCE METHODS
  // ========================================

  /**
   * Connect to multiple clients at once
   */
  async connectMultipleClients(clientIds: string[]): Promise<Array<{ clientId: string; success: boolean; message: string }>> {
    const results = await Promise.allSettled(
      clientIds.map(async (clientId) => {
        try {
          const result = await this.connectClient(clientId);
          return { clientId, ...result };
        } catch (error) {
          return {
            clientId,
            success: false,
            message: error instanceof Error ? error.message : 'Unknown error'
          };
        }
      })
    );

    return results.map((result, index) => 
      result.status === 'fulfilled' 
        ? result.value 
        : { clientId: clientIds[index], success: false, message: result.reason?.message || 'Failed to connect' }
    );
  }

  /**
   * Get status for all clients
   */
  async getAllClientStatuses(): Promise<Array<{ client: MCPClient; status: ClientStatus }>> {
    const clients = await this.getClients();
    
    const statuses = await Promise.allSettled(
      clients.map(async (client) => {
        try {
          const status = await this.getClientStatus(client.id);
          return { client, status };
        } catch (error) {
          return {
            client,
            status: {
              client_id: client.id,
              status: 'error',
              last_seen: null,
              last_error: error instanceof Error ? error.message : 'Unknown error',
              is_active: false
            }
          };
        }
      })
    );

    return statuses.map((result) =>
      result.status === 'fulfilled' ? result.value : result.reason
    );
  }

  /**
   * Auto-connect to all clients marked with auto_connect
   */
  async autoConnectClients(): Promise<Array<{ clientId: string; success: boolean; message: string }>> {
    const clients = await this.getClients();
    const autoConnectClients = clients.filter(client => client.auto_connect);
    
    if (autoConnectClients.length === 0) {
      return [];
    }

    return this.connectMultipleClients(autoConnectClients.map(c => c.id));
  }

  // ========================================
  // ARCHON INTEGRATION HELPERS
  // ========================================

  /**
   * Create Archon MCP client using Streamable HTTP transport
   */
  async createArchonClient(): Promise<MCPClient> {
    // Require ARCHON_MCP_PORT to be set
    const mcpPort = import.meta.env.ARCHON_MCP_PORT;
    if (!mcpPort) {
      throw new Error(
        'ARCHON_MCP_PORT environment variable is required. ' +
        'Please set it in your environment variables. ' +
        'Default value: 8051'
      );
    }
    
    // Get the host from the API URL
    const apiUrl = getApiUrl();
    const url = new URL(apiUrl || `http://${window.location.hostname}:${mcpPort}`);
    const mcpUrl = `${url.protocol}//${url.hostname}:${mcpPort}/mcp`;
    
    const archonConfig: MCPClientConfig = {
      name: 'Archon',
      transport_type: 'http',
      connection_config: {
        url: mcpUrl
      },
      auto_connect: true,
      health_check_interval: 30,
      is_default: true
    };

    return this.createClient(archonConfig);
  }

  /**
   * Get the default Archon client (or create if doesn't exist)
   */
  async getOrCreateArchonClient(): Promise<MCPClient> {
    const clients = await this.getClients();
    const archonClient = clients.find(client => client.is_default || client.name === 'Archon');

    if (archonClient) {
      return archonClient;
    }

    return this.createArchonClient();
  }
}

export const mcpClientService = new MCPClientService(); 