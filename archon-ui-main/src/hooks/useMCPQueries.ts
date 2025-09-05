import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { mcpServerService } from '../services/mcpServerService';
import { useToast } from '../contexts/ToastContext';

// Query keys
export const mcpKeys = {
  all: ['mcp'] as const,
  status: () => [...mcpKeys.all, 'status'] as const,
  config: () => [...mcpKeys.all, 'config'] as const,
  tools: () => [...mcpKeys.all, 'tools'] as const,
};

// Fetch MCP server status
export function useMCPStatus() {
  return useQuery({
    queryKey: mcpKeys.status(),
    queryFn: () => mcpServerService.getStatus(),
    staleTime: 5 * 60 * 1000, // 5 minutes - status rarely changes
    refetchOnWindowFocus: false,
  });
}

// Fetch MCP server config
export function useMCPConfig(enabled = true) {
  return useQuery({
    queryKey: mcpKeys.config(),
    queryFn: () => mcpServerService.getConfiguration(),
    enabled,
    staleTime: Infinity, // Config never changes unless server restarts
  });
}

// Start server mutation
export function useStartMCPServer() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: () => mcpServerService.startServer(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mcpKeys.status() });
      queryClient.invalidateQueries({ queryKey: mcpKeys.config() });
      showToast('MCP server started successfully', 'success');
    },
    onError: (error: any) => {
      showToast(error.message || 'Failed to start server', 'error');
    },
  });
}

// Stop server mutation
export function useStopMCPServer() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: () => mcpServerService.stopServer(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mcpKeys.status() });
      queryClient.removeQueries({ queryKey: mcpKeys.config() });
      showToast('MCP server stopped', 'info');
    },
    onError: (error: any) => {
      showToast(error.message || 'Failed to stop server', 'error');
    },
  });
}

// List MCP tools
export function useMCPTools(enabled = true) {
  return useQuery({
    queryKey: mcpKeys.tools(),
    queryFn: () => mcpServerService.listTools(),
    enabled,
    staleTime: Infinity, // Tools don't change during runtime
  });
}