import { writeFile, access } from 'fs/promises';
import { join } from 'path';
import type { CommandResult, Conversation } from '../../types';
import * as codebaseDb from '../../db/codebases';
import { getLog } from './log';

/**
 * Create the .archon structure in the effective working directory: the explicit
 * runtime override (conversation.cwd) when set, else the selected project's root.
 * Web-created project conversations have codebase_id but null cwd (issue #1993),
 * so the fallback is what makes /init work there.
 */
export async function handleInitCommand(conversation: Conversation): Promise<CommandResult> {
  const initCodebase = conversation.codebase_id
    ? await codebaseDb.getCodebase(conversation.codebase_id)
    : null;
  const initCwd = conversation.cwd ?? initCodebase?.default_cwd;
  if (!initCwd) {
    return {
      success: false,
      message:
        'No project selected. Pick one with /setproject <name> (register it first with /register-project if needed).',
    };
  }

  const archonDir = join(initCwd, '.archon');
  const commandsDir = join(archonDir, 'commands');
  const configPath = join(archonDir, 'config.yaml');

  try {
    // Check if .archon already exists
    try {
      await access(archonDir);
      return {
        success: false,
        message: '.archon directory already exists. Nothing to do.',
      };
    } catch {
      // Directory doesn't exist, we can create it
    }

    // Create directories
    await import('fs/promises').then(fs => fs.mkdir(commandsDir, { recursive: true }));

    // Create default config.yaml
    const defaultConfig = `# Archon repository configuration
# See: https://github.com/coleam00/Archon

# AI assistant preference (optional - overrides global default)
# assistant: claude

# Commands configuration (optional)
# commands:
#   folder: .archon/commands
#   autoLoad: true
`;
    await writeFile(configPath, defaultConfig);

    // Create example command
    const exampleCommand = join(commandsDir, 'example.md');
    const exampleContent = `---
description: Example command
---
# Example Command

This is an example command.

Arguments:
- $ARGUMENTS - The full trigger message

Task: $ARGUMENTS
`;
    await writeFile(exampleCommand, exampleContent);

    return {
      success: true,
      message: `Created .archon structure:
  .archon/
  ├── config.yaml
  └── commands/
      └── example.md

Commands are auto-discovered from .archon/commands/ — no registration needed.`,
    };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, command: 'init' }, 'cmd.init_failed');
    return { success: false, message: `Failed to initialize: ${err.message}` };
  }
}
