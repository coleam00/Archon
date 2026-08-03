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
export function formatToolCall(toolName: string, toolInput?: Record<string, unknown>): string {
  // Start with tool emoji and name
  let message = `🔧 ${toolName.toUpperCase()}`;

  // Add brief command/input info if available
  if (toolInput) {
    const briefInfo = extractBriefInfo(toolName, toolInput);
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
function extractBriefInfo(toolName: string, toolInput: Record<string, unknown>): string | null {
  // Bash commands - show the command (truncated)
  if (toolName === 'Bash' && toolInput.command) {
    const cmd = toolInput.command as string;
    return cmd.length > 100 ? cmd.substring(0, 100) + '...' : cmd;
  }

  // Read operations - show file path
  if (toolName === 'Read' && toolInput.file_path) {
    return `Reading: ${toolInput.file_path as string}`;
  }

  // Write operations - show file path
  if (toolName === 'Write' && toolInput.file_path) {
    return `Writing: ${toolInput.file_path as string}`;
  }

  // Edit operations - show file path
  if (toolName === 'Edit' && toolInput.file_path) {
    return `Editing: ${toolInput.file_path as string}`;
  }

  // Glob operations - show pattern
  if (toolName === 'Glob' && toolInput.pattern) {
    return `Pattern: ${toolInput.pattern as string}`;
  }

  // Grep operations - show pattern
  if (toolName === 'Grep' && toolInput.pattern) {
    return `Searching: ${toolInput.pattern as string}`;
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
