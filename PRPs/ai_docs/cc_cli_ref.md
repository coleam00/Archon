# CLI reference

> Complete reference for Claude Code command-line interface, including commands and flags.

## CLI commands

| Command                            | Description                                    | Example                                                            |
| :--------------------------------- | :--------------------------------------------- | :----------------------------------------------------------------- |
| `claude`                           | Start interactive REPL                         | `claude`                                                           |
| `claude "query"`                   | Start REPL with initial prompt                 | `claude "explain this project"`                                    |
| `claude -p "query"`                | Query via SDK, then exit                       | `claude -p "explain this function"`                                |
| `cat file \| claude -p "query"`    | Process piped content                          | `cat logs.txt \| claude -p "explain"`                              |
| `claude -c`                        | Continue most recent conversation              | `claude -c`                                                        |
| `claude -c -p "query"`             | Continue via SDK                               | `claude -c -p "Check for type errors"`                             |
| `claude -r "<session-id>" "query"` | Resume session by ID                           | `claude -r "abc123" "Finish this PR"`                              |
| `claude update`                    | Update to latest version                       | `claude update`                                                    |
| `claude mcp`                       | Configure Model Context Protocol (MCP) servers | See the [Claude Code MCP documentation](/en/docs/claude-code/mcp). |

## CLI flags

Customize Claude Code's behavior with these command-line flags:

| Flag                             | Description                                                                                                                                              | Example                                                                                            |
| :------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------- |
| `--add-dir`                      | Add additional working directories for Claude to access (validates each path exists as a directory)                                                      | `claude --add-dir ../apps ../lib`                                                                  |
| `--agents`                       | Define custom [subagents](/en/docs/claude-code/sub-agents) dynamically via JSON (see below for format)                                                   | `claude --agents '{"reviewer":{"description":"Reviews code","prompt":"You are a code reviewer"}}'` |
| `--allowedTools`                 | A list of tools that should be allowed without prompting the user for permission, in addition to [settings.json files](/en/docs/claude-code/settings)    | `"Bash(git log:*)" "Bash(git diff:*)" "Read"`                                                      |
| `--disallowedTools`              | A list of tools that should be disallowed without prompting the user for permission, in addition to [settings.json files](/en/docs/claude-code/settings) | `"Bash(git log:*)" "Bash(git diff:*)" "Edit"`                                                      |
| `--print`, `-p`                  | Print response without interactive mode (see [SDK documentation](/en/docs/claude-code/sdk) for programmatic usage details)                               | `claude -p "query"`                                                                                |
| `--append-system-prompt`         | Append to system prompt (only with `--print`)                                                                                                            | `claude --append-system-prompt "Custom instruction"`                                               |
| `--output-format`                | Specify output format for print mode (options: `text`, `json`, `stream-json`)                                                                            | `claude -p "query" --output-format json`                                                           |
| `--input-format`                 | Specify input format for print mode (options: `text`, `stream-json`)                                                                                     | `claude -p --output-format json --input-format stream-json`                                        |
| `--include-partial-messages`     | Include partial streaming events in output (requires `--print` and `--output-format=stream-json`)                                                        | `claude -p --output-format stream-json --include-partial-messages "query"`                         |
| `--verbose`                      | Enable verbose logging, shows full turn-by-turn output (helpful for debugging in both print and interactive modes)                                       | `claude --verbose`                                                                                 |
| `--max-turns`                    | Limit the number of agentic turns in non-interactive mode                                                                                                | `claude -p --max-turns 3 "query"`                                                                  |
| `--model`                        | Sets the model for the current session with an alias for the latest model (`sonnet` or `opus`) or a model's full name                                    | `claude --model claude-sonnet-4-5-20250929`                                                        |
| `--permission-mode`              | Begin in a specified [permission mode](iam#permission-modes)                                                                                             | `claude --permission-mode plan`                                                                    |
| `--permission-prompt-tool`       | Specify an MCP tool to handle permission prompts in non-interactive mode                                                                                 | `claude -p --permission-prompt-tool mcp_auth_tool "query"`                                         |
| `--resume`                       | Resume a specific session by ID, or by choosing in interactive mode                                                                                      | `claude --resume abc123 "query"`                                                                   |
| `--continue`                     | Load the most recent conversation in the current directory                                                                                               | `claude --continue`                                                                                |
| `--dangerously-skip-permissions` | Skip permission prompts (use with caution)                                                                                                               | `claude --dangerously-skip-permissions`                                                            |

<Tip>
  The `--output-format json` flag is particularly useful for scripting and
  automation, allowing you to parse Claude's responses programmatically.
</Tip>

### Agents flag format

The `--agents` flag accepts a JSON object that defines one or more custom subagents. Each subagent requires a unique name (as the key) and a definition object with the following fields:

| Field         | Required | Description                                                                                                     |
| :------------ | :------- | :-------------------------------------------------------------------------------------------------------------- |
| `description` | Yes      | Natural language description of when the subagent should be invoked                                             |
| `prompt`      | Yes      | The system prompt that guides the subagent's behavior                                                           |
| `tools`       | No       | Array of specific tools the subagent can use (e.g., `["Read", "Edit", "Bash"]`). If omitted, inherits all tools |
| `model`       | No       | Model alias to use: `sonnet`, `opus`, or `haiku`. If omitted, uses the default subagent model                   |

Example:

```bash theme={null}
claude --agents '{
  "code-reviewer": {
    "description": "Expert code reviewer. Use proactively after code changes.",
    "prompt": "You are a senior code reviewer. Focus on code quality, security, and best practices.",
    "tools": ["Read", "Grep", "Glob", "Bash"],
    "model": "sonnet"
  },
  "debugger": {
    "description": "Debugging specialist for errors and test failures.",
    "prompt": "You are an expert debugger. Analyze errors, identify root causes, and provide fixes."
  }
}'
```

For more details on creating and using subagents, see the [subagents documentation](/en/docs/claude-code/sub-agents).

For detailed information about print mode (`-p`) including output formats,
streaming, verbose logging, and programmatic usage, see the
[SDK documentation](/en/docs/claude-code/sdk).

## See also

- [Interactive mode](/en/docs/claude-code/interactive-mode) - Shortcuts, input modes, and interactive features
- [Slash commands](/en/docs/claude-code/slash-commands) - Interactive session commands
- [Quickstart guide](/en/docs/claude-code/quickstart) - Getting started with Claude Code
- [Common workflows](/en/docs/claude-code/common-workflows) - Advanced workflows and patterns
- [Settings](/en/docs/claude-code/settings) - Configuration options
- [SDK documentation](/en/docs/claude-code/sdk) - Programmatic usage and integrations
