import type { AgentDraft } from './agent-draft';

interface MCPTabProps {
  draft: AgentDraft;
  onPatch: (patch: Partial<AgentDraft>) => void;
}

export function MCPTab({ draft, onPatch }: MCPTabProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="text-[15px] font-semibold text-bridges-fg1">MCP servers</div>
        <div className="mt-1 text-[12.5px] leading-snug text-bridges-fg2">
          Path to a JSON file describing MCP servers the agent can call. The path is resolved
          relative to the project cwd. Use the Validate button to verify connectivity and see the
          resolved server names.
        </div>
      </div>

      <div>
        <div className="mb-1 text-[12.5px] font-medium text-bridges-fg1">Config file path</div>
        <div className="mb-2 text-[11.5px] text-bridges-fg3">
          Example: <code className="font-mono">mcp.json</code> or{' '}
          <code className="font-mono">.archon/mcp.json</code>. Leave empty to disable MCP for this
          agent.
        </div>
        <input
          type="text"
          value={draft.mcp}
          onChange={e => {
            onPatch({ mcp: e.target.value });
          }}
          placeholder="mcp.json"
          className="w-full rounded-md border border-bridges-border bg-bridges-surface px-2.5 py-1.5 font-mono text-[12.5px] text-bridges-fg1 placeholder:text-bridges-fg-placeholder focus:border-bridges-border-strong focus:outline-none focus:ring-2 focus:ring-blue-500/20"
        />
      </div>

      <div className="rounded-md border border-bridges-border-subtle bg-bridges-surface-subtle px-3 py-3">
        <div className="text-[12px] font-semibold text-bridges-fg1">Format</div>
        <pre className="mt-1.5 overflow-x-auto rounded bg-bridges-surface px-2.5 py-2 font-mono text-[11px] leading-snug text-bridges-fg2">
          {`{
  "github": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_TOKEN": "$GITHUB_TOKEN" }
  }
}`}
        </pre>
        <div className="mt-2 text-[11.5px] text-bridges-fg3">
          Tools become <code className="font-mono">mcp__&lt;server&gt;__&lt;tool&gt;</code>. Use the
          Tools tab's granular allow list to restrict, or accept everything by default.
        </div>
      </div>
    </div>
  );
}
