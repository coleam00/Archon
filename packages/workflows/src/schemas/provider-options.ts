/**
 * Per-node provider option schemas: the Claude Agent SDK options a node may set
 * (`betas`, `sandbox`), the Pi extension posture (`pi`), and the `mcp:` declaration.
 */
import { z } from 'zod';

/**
 * Claude Agent SDK beta header list. Non-empty array of non-empty strings —
 * the SDK expects either a populated beta header or none at all. `.nonempty()`
 * enforces the min-length-1 rule at runtime; it does not narrow the inferred
 * TypeScript type to a non-empty tuple (the type stays `string[]`).
 */
export const betasSchema = z.array(z.string().min(1)).nonempty("'betas' must be a non-empty array");

/**
 * Claude Agent SDK SandboxSettings — OS-level filesystem/network restrictions.
 * Uses passthrough() to match the SDK's loose schema (index signature allows extra fields).
 */
export const sandboxSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    autoAllowBashIfSandboxed: z.boolean().optional(),
    allowUnsandboxedCommands: z.boolean().optional(),
    network: z
      .object({
        allowedDomains: z.array(z.string()).optional(),
        allowManagedDomainsOnly: z.boolean().optional(),
        allowUnixSockets: z.array(z.string()).optional(),
        allowAllUnixSockets: z.boolean().optional(),
        allowLocalBinding: z.boolean().optional(),
        httpProxyPort: z.number().optional(),
        socksProxyPort: z.number().optional(),
      })
      .optional(),
    filesystem: z
      .object({
        allowWrite: z.array(z.string()).optional(),
        denyWrite: z.array(z.string()).optional(),
        denyRead: z.array(z.string()).optional(),
      })
      .optional(),
    ignoreViolations: z.record(z.string(), z.array(z.string())).optional(),
    enableWeakerNestedSandbox: z.boolean().optional(),
    enableWeakerNetworkIsolation: z.boolean().optional(),
    excludedCommands: z.array(z.string()).optional(),
    ripgrep: z
      .object({
        command: z.string(),
        args: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .passthrough();

export type SandboxSettings = z.infer<typeof sandboxSettingsSchema>;

/**
 * Per-node Pi extension posture — the PORTABLE authoring surface for issue #2133.
 * Mirrors the install-level `assistants.pi.nodes.<nodeId>` override map (#2124),
 * but lives on the node itself so it travels with the workflow instead of a
 * machine's `config.yaml`. Highest-precedence layer: node YAML `pi:` > config
 * `nodes.<id>` > assistant-level `assistants.pi.*`. Structurally identical to the
 * provider contract's `PiExtensionPosture`; pi-extension-posture.type-test.ts
 * checks the authoring schema against that SDK-free contract.
 *
 * Pi-only, like Claude's `hooks`/`mcp`/`skills`/`agents`. Other providers ignore
 * it; non-AI node types warn it's ignored (see BASH_NODE_AI_FIELDS).
 */
export const piNodeConfigSchema = z.object({
  /** Override extension discovery for this node (`assistants.pi.enableExtensions`). */
  enableExtensions: z.boolean().optional(),
  /** Override the UIContext binding (`ctx.hasUI`) for this node. */
  interactive: z.boolean().optional(),
  /**
   * Per-node extension flags, shallow-merged over the assistant-level and
   * config `nodes.<id>` flags (node YAML wins). Set a flag to `false` to negate
   * an inherited `true` (extensions check `getFlag(name) === true`).
   */
  extensionFlags: z.record(z.string(), z.union([z.boolean(), z.string()])).optional(),
});

export type PiNodeConfig = z.infer<typeof piNodeConfigSchema>;

/**
 * A node's `mcp:` declaration: a config-file path the node requires, or
 * `{ path, optional: true }` for a server the node runs without when its provider
 * cannot load MCP servers or the file does not exist. Strict so a misspelled
 * `optional` fails the load instead of silently meaning required.
 */
export const nodeMcpSchema = z.union([
  z.string().min(1, "'mcp' must be a non-empty string path"),
  z.strictObject({
    path: z.string().min(1, "'mcp.path' must be a non-empty string path"),
    optional: z.boolean().optional(),
  }),
]);

export type NodeMcp = z.infer<typeof nodeMcpSchema>;

export interface McpDeclaration {
  path: string;
  optional: boolean;
}

export function mcpDeclaration(mcp: NodeMcp | undefined): McpDeclaration | undefined {
  if (mcp === undefined) return undefined;
  return typeof mcp === 'string'
    ? { path: mcp, optional: false }
    : { path: mcp.path, optional: mcp.optional === true };
}
