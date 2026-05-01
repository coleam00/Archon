/**
 * @archon/core/skills — Claude Agent SDK skill registry.
 *
 * Pure filesystem CRUD over `~/.claude/skills/` and `<cwd>/.claude/skills/`.
 * Used by the server's REST API to power the Web UI skill registry.
 */

export type {
  SkillSource,
  SkillSummary,
  SkillDetail,
  SkillFileNode,
  SkillLoadError,
  SkillDiscoveryResult,
} from './types';
export { SkillFrontmatterError, SkillNameError, SkillPathTraversalError } from './types';

export { parseSkillMd, serializeSkillMd, validateSkillName, derivePrefix } from './frontmatter';

export { discoverSkills, getSkillDir, getSkillsSearchPaths } from './discovery';

export { readSkill, writeSkillMd, createSkill, deleteSkill } from './read-write';

export {
  listSkillFiles,
  readSkillFile,
  writeSkillFile,
  deleteSkillFile,
  resolveSafeFilePath,
} from './files';
