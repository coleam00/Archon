/**
 * Bundled Archon skill files for binary distribution
 *
 * These static imports are resolved at compile time and embedded into the binary.
 * When running as a standalone binary (without Bun), these provide the skill files
 * without needing filesystem access to the source repo.
 *
 * Import syntax uses `with { type: 'text' }` to import file contents as strings.
 */

// =============================================================================
// Skill Files (23 total)
// =============================================================================

import skillMd from '../../../.agents/skills/archon/SKILL.md' with { type: 'text' };
import openAiAgent from '../../../.agents/skills/archon/agents/openai.yaml' with { type: 'text' };
import commandTemplate from '../../../.agents/skills/archon/examples/command-template.md' with { type: 'text' };
import dagWorkflow from '../../../.agents/skills/archon/examples/dag-workflow.yaml' with { type: 'text' };
import cliGuide from '../../../.agents/skills/archon/guides/cli.md' with { type: 'text' };
import configGuide from '../../../.agents/skills/archon/guides/config.md' with { type: 'text' };
import discordGuide from '../../../.agents/skills/archon/guides/discord.md' with { type: 'text' };
import githubGuide from '../../../.agents/skills/archon/guides/github.md' with { type: 'text' };
import serverGuide from '../../../.agents/skills/archon/guides/server.md' with { type: 'text' };
import setupGuide from '../../../.agents/skills/archon/guides/setup.md' with { type: 'text' };
import slackGuide from '../../../.agents/skills/archon/guides/slack.md' with { type: 'text' };
import telegramGuide from '../../../.agents/skills/archon/guides/telegram.md' with { type: 'text' };
import authoringCommands from '../../../.agents/skills/archon/references/authoring-commands.md' with { type: 'text' };
import cliCommands from '../../../.agents/skills/archon/references/cli-commands.md' with { type: 'text' };
import codexCapabilityCrosswalk from '../../../.agents/skills/archon/references/codex-capability-crosswalk.md' with { type: 'text' };
import configuration from '../../../.agents/skills/archon/references/configuration.md' with { type: 'text' };
import dagAdvanced from '../../../.agents/skills/archon/references/dag-advanced.md' with { type: 'text' };
import interactiveWorkflows from '../../../.agents/skills/archon/references/interactive-workflows.md' with { type: 'text' };
import logDebugging from '../../../.agents/skills/archon/references/log-debugging.md' with { type: 'text' };
import monitoring from '../../../.agents/skills/archon/references/monitoring.md' with { type: 'text' };
import repoInit from '../../../.agents/skills/archon/references/repo-init.md' with { type: 'text' };
import variables from '../../../.agents/skills/archon/references/variables.md' with { type: 'text' };
import workflowDag from '../../../.agents/skills/archon/references/workflow-dag.md' with { type: 'text' };

// =============================================================================
// Export
// =============================================================================

/**
 * Bundled skill files - relative path within the canonical Archon skill tree -> content
 */
export const BUNDLED_SKILL_FILES: Record<string, string> = {
  'SKILL.md': skillMd,
  'agents/openai.yaml': openAiAgent,
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
  'references/codex-capability-crosswalk.md': codexCapabilityCrosswalk,
  'references/configuration.md': configuration,
  'references/dag-advanced.md': dagAdvanced,
  'references/interactive-workflows.md': interactiveWorkflows,
  'references/log-debugging.md': logDebugging,
  'references/monitoring.md': monitoring,
  'references/repo-init.md': repoInit,
  'references/variables.md': variables,
  'references/workflow-dag.md': workflowDag,
};
