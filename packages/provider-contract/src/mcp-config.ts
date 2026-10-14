export type McpServerMap =
  | { ok: true; servers: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * The server map a parsed MCP config file declares: the top-level object itself, or
 * the object under a lone `"mcpServers"` key. Providers load these servers and the
 * engine scopes a node's tools by their names, so both read the file through here.
 */
export function mcpServerMap(parsed: unknown): McpServerMap {
  if (!isPlainRecord(parsed)) {
    return { ok: false, error: 'MCP config must be a JSON object (Record<string, ServerConfig>)' };
  }
  const keys = Object.keys(parsed);
  if (!keys.includes('mcpServers')) return { ok: true, servers: parsed };
  if (keys.length > 1) {
    return {
      ok: false,
      error:
        'MCP config cannot mix top-level "mcpServers" with other keys; use either a direct server map or { "mcpServers": { ... } }',
    };
  }
  if (!isPlainRecord(parsed.mcpServers)) {
    return { ok: false, error: 'MCP config field "mcpServers" must be a JSON object' };
  }
  return { ok: true, servers: parsed.mcpServers };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
