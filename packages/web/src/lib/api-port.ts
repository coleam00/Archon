export const DEFAULT_API_PORT = '3000';

/**
 * Resolves the API proxy port from environment values used by Vite.
 * Falls back to the server default when PORT is unset or blank.
 */
export function resolveApiPort(port: string | undefined): string {
  const value = port?.trim();
  return value ? value : DEFAULT_API_PORT;
}
