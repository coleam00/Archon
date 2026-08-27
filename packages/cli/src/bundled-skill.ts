/**
 * Bundled skill files for the `archon-cli` skill.
 *
 * Bun's `with { type: 'text' }` imports are hand-maintained (no glob imports at
 * compile time) — every file of the skill must be listed here and in the export
 * map below. `scripts/check-bundled-skill.ts` verifies this file covers every
 * file on disk under .claude/skills/archon-cli/; run it after adding or removing
 * any skill file.
 */
import router from '../../../.claude/skills/archon-cli/SKILL.md' with { type: 'text' };
import runningWorkflows from '../../../.claude/skills/archon-cli/running-workflows/running-workflows.md' with { type: 'text' };
import manageRuns from '../../../.claude/skills/archon-cli/manage-run/manage-runs.md' with { type: 'text' };
import troubleshooting from '../../../.claude/skills/archon-cli/manage-run/troubleshooting.md' with { type: 'text' };
import setupAndConfig from '../../../.claude/skills/archon-cli/setup-and-config/setup-and-config.md' with { type: 'text' };
import authoringWorkflows from '../../../.claude/skills/archon-cli/authoring-workflows/authoring-workflows.md' with { type: 'text' };
import nodeReference from '../../../.claude/skills/archon-cli/authoring-workflows/node-reference.md' with { type: 'text' };
import variables from '../../../.claude/skills/archon-cli/authoring-workflows/variables.md' with { type: 'text' };
import promptingMistakes from '../../../.claude/skills/archon-cli/prompting-mistakes/prompting-mistakes.md' with { type: 'text' };

/**
 * Bundled archon-cli skill files - path relative to .claude/skills/archon-cli/ -> content.
 */
export const BUNDLED_SKILL_FILES: Record<string, string> = {
  'SKILL.md': router,
  'running-workflows/running-workflows.md': runningWorkflows,
  'manage-run/manage-runs.md': manageRuns,
  'manage-run/troubleshooting.md': troubleshooting,
  'setup-and-config/setup-and-config.md': setupAndConfig,
  'authoring-workflows/authoring-workflows.md': authoringWorkflows,
  'authoring-workflows/node-reference.md': nodeReference,
  'authoring-workflows/variables.md': variables,
  'prompting-mistakes/prompting-mistakes.md': promptingMistakes,
};
