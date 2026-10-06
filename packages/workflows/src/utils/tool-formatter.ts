/**
 * Tool Call Formatter
 *
 * Formats tool calls from AI assistants into user-friendly messages
 * Based on claude-telegram-bot (lines 572-604) and codex-telegram-bot patterns
 */

/**
 * Format a tool call for display
 *
 * @param toolName - Name of the tool being called
 * @param toolInput - Input parameters for the tool
 * @returns Formatted tool message with emoji and brief description
 */
export function formatToolCall(toolName: string, toolInput?: unknown): string {
  // Start with tool emoji and name
  let message = `🔧 ${toolName.toUpperCase()}`;

  // Add brief command/input info if available
  if (toolInput !== undefined) {
    const briefInfo = formatToolInputBrief(toolName, toolInput);
    if (briefInfo) {
      message += `\n${briefInfo}`;
    }
  }

  return message;
}

/**
 * Extract brief, relevant info from tool input
 *
 * @param toolName - Name of the tool
 * @param toolInput - Tool input parameters
 * @returns Brief description of what the tool is doing
 */
export function formatToolInputBrief(toolName: string, toolInput: unknown): string | null {
  if (typeof toolInput === 'object' && toolInput !== null) {
    if (toolName === 'Bash' && 'command' in toolInput && typeof toolInput.command === 'string') {
      const cmd = toolInput.command;
      return cmd.length > 100 ? cmd.substring(0, 100) + '...' : cmd;
    }
    if ('file_path' in toolInput && typeof toolInput.file_path === 'string') {
      if (toolName === 'Read') return `Reading: ${toolInput.file_path}`;
      if (toolName === 'Write') return `Writing: ${toolInput.file_path}`;
      if (toolName === 'Edit') return `Editing: ${toolInput.file_path}`;
    }
    if ('pattern' in toolInput && typeof toolInput.pattern === 'string') {
      if (toolName === 'Glob') return `Pattern: ${toolInput.pattern}`;
      if (toolName === 'Grep') return `Searching: ${toolInput.pattern}`;
    }
  }

  // MCP tools - show tool name
  if (toolName.startsWith('mcp__')) {
    // Extract readable name from mcp__server__tool format
    const parts = toolName.split('__');
    if (parts.length >= 2) {
      return `MCP: ${parts.slice(1).join(' ')}`;
    }
  }

  // Generic handling for other tools - show JSON input (truncated)
  const toolInputStr = JSON.stringify(toolInput);
  if (toolInputStr === undefined) return null;
  if (toolInputStr.length > 80) {
    return toolInputStr.substring(0, 80) + '...';
  }
  return toolInputStr;
}

/**
 * Format thinking/reasoning for display (optional)
 *
 * @param thinking - Thinking text from AI
 * @returns Formatted thinking message
 */
export function formatThinking(thinking: string): string {
  const maxLength = 200;
  if (thinking.length > maxLength) {
    return `💭 ${thinking.substring(0, maxLength)}...`;
  }
  return `💭 ${thinking}`;
}
