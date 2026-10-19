/**
 * Bun text imports embed the skill in compiled CLIs. `commands/skill.test.ts`
 * verifies that the exported map covers every file in the shipped skill directory.
 */
import core from '../../../.claude/skills/archon-cli/SKILL.md' with { type: 'text' };
import running from '../../../.claude/skills/archon-cli/operate/running.md' with { type: 'text' };
import managingRuns from '../../../.claude/skills/archon-cli/operate/managing-runs.md' with {
  type: 'text',
};
import queues from '../../../.claude/skills/archon-cli/operate/queues.md' with { type: 'text' };
import troubleshooting from '../../../.claude/skills/archon-cli/operate/troubleshooting.md' with {
  type: 'text',
};
import setupAndConfig from '../../../.claude/skills/archon-cli/setup/setup-and-config.md' with {
  type: 'text',
};
import authoringWorkflows from '../../../.claude/skills/archon-cli/authoring/authoring-workflows.md' with {
  type: 'text',
};
import nodeReference from '../../../.claude/skills/archon-cli/authoring/node-reference.md' with {
  type: 'text',
};
import variables from '../../../.claude/skills/archon-cli/authoring/variables.md' with {
  type: 'text',
};
import promptingMistakes from '../../../.claude/skills/archon-cli/authoring/prompting-mistakes.md' with {
  type: 'text',
};

/**
 * Bundled archon-cli skill files - path relative to .claude/skills/archon-cli/ -> content.
 */
export const BUNDLED_SKILL_FILES: Record<string, string> = {
  'SKILL.md': core,
  'operate/running.md': running,
  'operate/managing-runs.md': managingRuns,
  'operate/queues.md': queues,
  'operate/troubleshooting.md': troubleshooting,
  'setup/setup-and-config.md': setupAndConfig,
  'authoring/authoring-workflows.md': authoringWorkflows,
  'authoring/node-reference.md': nodeReference,
  'authoring/variables.md': variables,
  'authoring/prompting-mistakes.md': promptingMistakes,
};
