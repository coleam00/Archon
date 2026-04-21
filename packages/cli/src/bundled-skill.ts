/**
 * Bundled HarneesLab skill files for binary distribution
 *
 * These static imports are resolved at compile time and embedded into the binary.
 * When running as a standalone binary (without Bun), these provide the skill files
 * without needing filesystem access to the source repo.
 *
 * Import syntax uses `with { type: 'text' }` to import file contents as strings.
 */

// =============================================================================
// Skill Files (18 total)
// =============================================================================

import skillMd from '../../../.claude/skills/hlab/SKILL.md' with { type: 'text' };
import commandTemplate from '../../../.claude/skills/hlab/examples/command-template.md' with { type: 'text' };
import dagWorkflow from '../../../.claude/skills/hlab/examples/dag-workflow.yaml' with { type: 'text' };
import cliGuide from '../../../.claude/skills/hlab/guides/cli.md' with { type: 'text' };
import configGuide from '../../../.claude/skills/hlab/guides/config.md' with { type: 'text' };
import discordGuide from '../../../.claude/skills/hlab/guides/discord.md' with { type: 'text' };
import githubGuide from '../../../.claude/skills/hlab/guides/github.md' with { type: 'text' };
import serverGuide from '../../../.claude/skills/hlab/guides/server.md' with { type: 'text' };
import setupGuide from '../../../.claude/skills/hlab/guides/setup.md' with { type: 'text' };
import slackGuide from '../../../.claude/skills/hlab/guides/slack.md' with { type: 'text' };
import telegramGuide from '../../../.claude/skills/hlab/guides/telegram.md' with { type: 'text' };
import authoringCommands from '../../../.claude/skills/hlab/references/authoring-commands.md' with { type: 'text' };
import cliCommands from '../../../.claude/skills/hlab/references/cli-commands.md' with { type: 'text' };
import dagAdvanced from '../../../.claude/skills/hlab/references/dag-advanced.md' with { type: 'text' };
import interactiveWorkflows from '../../../.claude/skills/hlab/references/interactive-workflows.md' with { type: 'text' };
import repoInit from '../../../.claude/skills/hlab/references/repo-init.md' with { type: 'text' };
import variables from '../../../.claude/skills/hlab/references/variables.md' with { type: 'text' };
import workflowDag from '../../../.claude/skills/hlab/references/workflow-dag.md' with { type: 'text' };

// =============================================================================
// Export
// =============================================================================

/**
 * Bundled skill files - relative path within .claude/skills/hlab/ -> content
 */
export const BUNDLED_SKILL_FILES: Record<string, string> = {
  'SKILL.md': skillMd,
  'examples/command-template.md': commandTemplate,
  'examples/dag-workflow.yaml': dagWorkflow,
  'guides/cli.md': cliGuide,
  'guides/config.md': configGuide,
  'guides/discord.md': discordGuide,
  'guides/github.md': githubGuide,
  'guides/server.md': serverGuide,
  'guides/setup.md': setupGuide,
  'guides/slack.md': slackGuide,
  'guides/telegram.md': telegramGuide,
  'references/authoring-commands.md': authoringCommands,
  'references/cli-commands.md': cliCommands,
  'references/dag-advanced.md': dagAdvanced,
  'references/interactive-workflows.md': interactiveWorkflows,
  'references/repo-init.md': repoInit,
  'references/variables.md': variables,
  'references/workflow-dag.md': workflowDag,
};
