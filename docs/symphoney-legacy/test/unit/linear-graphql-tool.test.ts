import { describe, it, expect, vi } from "vitest";
import {
  buildLinearGraphqlServer,
  LINEAR_GRAPHQL_FQN,
  LINEAR_GRAPHQL_MCP_NAME,
  LINEAR_GRAPHQL_TOOL_NAME,
  runLinearGraphql,
  validateOperation,
} from "../../src/agent/linear-graphql-tool.js";

describe("validateOperation (SPEC.md:1073-1077)", () => {
  it("rejects empty / whitespace-only", () => {
    expect(validateOperation("")).toMatch(/non-empty/i);
    expect(validateOperation("   \n  ")).toMatch(/non-empty/i);
  });

  it("rejects multiple operations", () => {
    expect(
      validateOperation("query A { viewer { id } } mutation B { issueUpdate { id } }"),
    ).toMatch(/exactly one/i);
  });

  it("accepts a single named query", () => {
    expect(validateOperation("query Issue { issue(id:\"x\") { id } }")).toBeNull();
  });

  it("accepts a single mutation", () => {
    expect(
      validateOperation(
        "mutation IssueUpdate($id: String!) { issueUpdate(id:$id, input:{stateId:\"y\"}) { issue { id } } }",
      ),
    ).toBeNull();
  });

  it("accepts shorthand selection-set form", () => {
    expect(validateOperation("{ viewer { id } }")).toBeNull();
  });

  it("ignores keywords inside strings and comments", () => {
    const q = `# query in a comment\nquery Real {\n  viewer {\n    id\n    name\n    bio\n    note: \"this mentions mutation but should not count\"\n  }\n}`;
    expect(validateOperation(q)).toBeNull();
  });
});

describe("runLinearGraphql (SPEC.md:1081-1086)", () => {
  const ENDPOINT = "https://api.linear.app/graphql";
  const KEY = "lin_xxx";

  it("returns success=true with data on a clean GraphQL response (SPEC.md:1082)", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      jsonResponse(200, { data: { viewer: { id: "u1" } } }),
    ) as unknown as typeof fetch;
    const result = await runLinearGraphql({
      endpoint: ENDPOINT,
      apiKey: KEY,
      query: "{ viewer { id } }",
      fetchImpl,
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ viewer: { id: "u1" } });
    const calls = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(1);
    const init = calls[0]![1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.query).toContain("viewer");
  });

  it("preserves GraphQL errors body and reports success=false (SPEC.md:1083-1084)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        data: null,
        errors: [{ message: "you cannot do that" }],
      }),
    );
    const result = await runLinearGraphql({
      endpoint: ENDPOINT,
      apiKey: KEY,
      query: "{ viewer { id } }",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.success).toBe(false);
    expect(result.errors).toEqual([{ message: "you cannot do that" }]);
    expect(result.data).toBeNull();
  });

  it("returns success=false with status on non-200", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: "unauth" }));
    const result = await runLinearGraphql({
      endpoint: ENDPOINT,
      apiKey: KEY,
      query: "{ viewer { id } }",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error?.code).toBe("linear_api_status");
  });

  it("returns transport error on fetch throw (SPEC.md:1085)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const result = await runLinearGraphql({
      endpoint: ENDPOINT,
      apiKey: KEY,
      query: "{ viewer { id } }",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("transport");
  });
});

describe("buildLinearGraphqlServer (SPEC.md:2018-2025)", () => {
  it("returns null when api key is missing (covers missing-auth failure path)", () => {
    expect(buildLinearGraphqlServer(null)).toBeNull();
    expect(
      buildLinearGraphqlServer({ endpoint: "https://api.linear.app/graphql", apiKey: "" }),
    ).toBeNull();
    expect(
      buildLinearGraphqlServer({ endpoint: "", apiKey: "tok" }),
    ).toBeNull();
  });

  it("returns an MCP server config registered under the symphony namespace", () => {
    const server = buildLinearGraphqlServer({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "tok",
    });
    expect(server).not.toBeNull();
    expect(server!.type).toBe("sdk");
    expect(server!.name).toBe(LINEAR_GRAPHQL_MCP_NAME);
  });

  it("exposes the spec-defined FQN constant", () => {
    expect(LINEAR_GRAPHQL_FQN).toBe(`mcp__${LINEAR_GRAPHQL_MCP_NAME}__${LINEAR_GRAPHQL_TOOL_NAME}`);
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
