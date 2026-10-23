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
  const brief = formatKnownToolInput(toolName, toolInput);
  if (brief !== null) return brief;
  if (toolName.startsWith('mcp__')) return `MCP: ${toolName.split('__').slice(1).join(' ')}`;
  return formatJsonInput(toolInput);
}

function formatKnownToolInput(toolName: string, input: unknown): string | null {
  switch (toolName) {
    case 'Bash': {
      const command = stringInput(input, 'command');
      return command === undefined ? null : truncate(command, 100);
    }
    case 'Read':
      return formatStringInput(input, 'file_path', 'Reading');
    case 'Write':
      return formatStringInput(input, 'file_path', 'Writing');
    case 'Edit':
      return formatStringInput(input, 'file_path', 'Editing');
    case 'Glob':
      return formatStringInput(input, 'pattern', 'Pattern');
    case 'Grep':
      return formatStringInput(input, 'pattern', 'Searching');
    default:
      return null;
  }
}

function stringInput(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null || !(key in input)) return undefined;
  const value: unknown = Reflect.get(input, key);
  return typeof value === 'string' ? value : undefined;
}

function formatStringInput(input: unknown, key: string, label: string): string | null {
  const value = stringInput(input, key);
  return value === undefined ? null : `${label}: ${value}`;
}

function formatJsonInput(input: unknown): string | null {
  const text = JSON.stringify(input);
  return text === undefined ? null : truncate(text, 80);
}

function truncate(text: string, length: number): string {
  return text.length > length ? text.substring(0, length) + '...' : text;
}
