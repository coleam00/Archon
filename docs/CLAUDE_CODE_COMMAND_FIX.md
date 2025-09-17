# Claude Code Command Fix

## Issue Description
There was a reported error in the Archon MCP documentation showing an incorrect Claude Code command.

## Original Issue
The documentation was reported to show:
```bash
claude mcp add --type http archon http://localhost:xxxx/mcp
```

## Correct Command
The correct command should be:
```bash
claude mcp add --transport http archon http://localhost:xxxx/mcp
```

## Current Status
After investigation of the current codebase, all instances of the Claude Code command in the repository already use the correct `--transport http` syntax:

1. **docs/docs/mcp-overview.mdx** - Line 81: Uses `--transport sse` (correct for SSE)
2. **docs/docs/mcp-server.mdx** - Line 99: Uses `--transport sse` (correct for SSE)
3. **archon-ui-main/src/features/mcp/components/McpConfigSection.tsx** - Line 191: Uses `--transport http` (correct for HTTP)

## Resolution
The main branch already contains the correct syntax. If the deployed instance at http://68.183.152.55:3737/mcp is showing the incorrect command, it may be running an older version of the code that needs to be updated.

## Files Checked
- ✅ All documentation files use correct `--transport` syntax
- ✅ All React components use correct `--transport` syntax
- ✅ No instances of `--type http` found in the codebase

## Recommendation
Update the deployed instance to use the latest version of the main branch to resolve the issue.