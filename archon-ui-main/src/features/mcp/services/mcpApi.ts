import { callAPIWithETag } from "../../shared/api/apiClient";
import type { McpClient, McpServerConfig, McpServerStatus, McpSessionInfo } from "../types";

export const mcpApi = {
  async getStatus(): Promise<McpServerStatus> {
    try {
      const response = await callAPIWithETag<McpServerStatus>("/api/mcp/status");
      return response;
    } catch (error) {
      console.error("Failed to get MCP status:", error);
      throw error;
    }
  },

  async getConfig(): Promise<McpServerConfig> {
    try {
      const response = await callAPIWithETag<McpServerConfig>("/api/mcp/config");
      return response;
    } catch (error) {
      console.error("Failed to get MCP config:", error);
      throw error;
    }
  },

  async getSessionInfo(): Promise<McpSessionInfo> {
    try {
      const response = await callAPIWithETag<McpSessionInfo>("/api/mcp/sessions");
      return response;
    } catch (error) {
      console.error("Failed to get session info:", error);
      throw error;
    }
  },

  async getClients(): Promise<McpClient[]> {
    try {
      const response = await callAPIWithETag<{ clients: McpClient[] }>("/api/mcp/clients");
      return response.clients || [];
    } catch (error) {
      console.error("Failed to get MCP clients:", error);
      throw error;
    }
  },
};
