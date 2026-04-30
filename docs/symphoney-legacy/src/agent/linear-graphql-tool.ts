import {
  tool,
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";

/**
 * `linear_graphql` client-side tool extension (SPEC.md:1047-1087).
 *
 * Spec contract:
 *  - single GraphQL operation per call (`SPEC.md:1073-1077`)
 *  - reuses configured Linear endpoint + auth (`SPEC.md:1079-1080`)
 *  - structured success/error result (`SPEC.md:1081-1086`)
 *
 * The executor (`runLinearGraphql`) is split from the MCP wrapper so the Codex
 * stdio backend can re-use it without depending on the Claude SDK's MCP types.
 */

export const LINEAR_GRAPHQL_MCP_NAME = "symphony";
export const LINEAR_GRAPHQL_TOOL_NAME = "linear_graphql";
export const LINEAR_GRAPHQL_FQN = `mcp__${LINEAR_GRAPHQL_MCP_NAME}__${LINEAR_GRAPHQL_TOOL_NAME}`;

export interface LinearGraphqlToolOptions {
  endpoint: string;
  apiKey: string;
  /** Override the global fetch implementation (used in tests). */
  fetchImpl?: typeof fetch;
  /** Optional network timeout in ms. Default: 30_000. */
  timeoutMs?: number;
}

export interface RunLinearGraphqlArgs {
  endpoint: string;
  apiKey: string;
  query: string;
  variables?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface LinearGraphqlResult {
  success: boolean;
  data?: unknown;
  errors?: unknown;
  status?: number;
  error?: { code: string; message: string };
}

const inputSchema = {
  query: z.string().min(1, "query must be a non-empty string"),
  variables: z.record(z.string(), z.unknown()).optional(),
};

const OPERATION_RE = /\b(query|mutation|subscription)\b/g;

/**
 * Build the in-process MCP server hosting `linear_graphql`. Returns null when
 * auth is missing — the tool is only meaningful with a configured Linear
 * endpoint + api key (`SPEC.md:1060`).
 */
export function buildLinearGraphqlServer(
  opts: LinearGraphqlToolOptions | null,
): McpSdkServerConfigWithInstance | null {
  if (!opts || !opts.apiKey || !opts.endpoint) return null;

  const linearTool = tool(
    LINEAR_GRAPHQL_TOOL_NAME,
    "Execute a single GraphQL query or mutation against Linear using Symphony's configured tracker auth.",
    inputSchema,
    async (args) => {
      const validation = validateOperation(args.query);
      if (validation) {
        const payload: LinearGraphqlResult = {
          success: false,
          error: { code: "invalid_input", message: validation },
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload) }],
          isError: true,
        };
      }
      const result = await runLinearGraphql({
        endpoint: opts.endpoint,
        apiKey: opts.apiKey,
        query: args.query,
        variables: args.variables ?? {},
        fetchImpl: opts.fetchImpl,
        timeoutMs: opts.timeoutMs,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        isError: !result.success,
      };
    },
  );

  return createSdkMcpServer({
    name: LINEAR_GRAPHQL_MCP_NAME,
    version: "0.1.0",
    tools: [linearTool],
  });
}

/**
 * Backend-agnostic executor. Both the Claude MCP server and the Codex stdio
 * client call this directly.
 */
export async function runLinearGraphql(
  args: RunLinearGraphqlArgs,
): Promise<LinearGraphqlResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const timeoutMs = args.timeoutMs ?? 30_000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(args.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: args.apiKey,
      },
      body: JSON.stringify({ query: args.query, variables: args.variables ?? {} }),
      signal: ac.signal,
    });
  } catch (err) {
    return {
      success: false,
      error: { code: "transport", message: (err as Error).message },
    };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      try {
        body = await res.text();
      } catch {
        body = null;
      }
    }
    return {
      success: false,
      status: res.status,
      error: { code: "linear_api_status", message: `non-200 ${res.status}` },
      data: body,
    };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    return {
      success: false,
      error: { code: "invalid_json", message: (err as Error).message },
    };
  }
  if (typeof json !== "object" || json === null) {
    return {
      success: false,
      error: { code: "invalid_payload", message: "response is not an object" },
    };
  }
  const obj = json as { data?: unknown; errors?: unknown };
  // Spec: top-level GraphQL `errors` -> success=false, preserve body for debugging.
  if (Array.isArray(obj.errors) && obj.errors.length > 0) {
    return { success: false, errors: obj.errors, data: obj.data ?? null };
  }
  return { success: true, data: obj.data ?? null };
}

/**
 * Validate the document contains exactly one GraphQL operation
 * (`SPEC.md:1073-1077`). Returns an error string or null.
 */
export function validateOperation(query: string): string | null {
  if (!query || !query.trim()) return "query must be a non-empty string";
  const stripped = stripCommentsAndStrings(query);
  let count = 0;
  for (const _ of stripped.matchAll(OPERATION_RE)) count++;
  if (count === 0) {
    // Allow shorthand `{ ... }` selection-set as a single operation.
    if (stripped.trim().startsWith("{")) return null;
    return "query must contain at least one GraphQL operation";
  }
  if (count > 1) return "query must contain exactly one GraphQL operation";
  return null;
}

function stripCommentsAndStrings(input: string): string {
  return input
    .replace(/#[^\n]*/g, "")
    .replace(/"""[\s\S]*?"""/g, "")
    .replace(/"(?:\\.|[^"\\])*"/g, "");
}
