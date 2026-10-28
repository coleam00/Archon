import { join } from 'path';
import { access } from 'fs/promises';
import {
  findInstalledSkillNames,
  parseSettingSources,
  DEFAULT_SETTING_SOURCES,
  projectSkillSearchRoots,
  skillSearchRoots,
} from '@archon/paths/skills';
import { declaredSkillRoots } from '@archon/provider-contract';
import type { NodeValidation, ResourceValidation } from './context';

/** Where one node's provider looks for skills, and which of those roots are the project's. */
interface SkillScope {
  discovery: NonNullable<NodeValidation['descriptor']>['skillDiscovery'];
  env: Record<string, string> | undefined;
  searchRoots: string[];
  projectRoots: string[];
}

/** Check if a file exists */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Named skills resolve to a skill directory the node's provider loads. */
export async function validateSkills(
  validation: ResourceValidation,
  scope: NodeValidation
): Promise<void> {
  const { node, provider, capabilities } = scope;
  if (!('skills' in node) || !Array.isArray(node.skills)) return;
  // Only validate filesystem names when the provider actually consumes the
  // YAML list. In particular, Codex's native roots/metadata rules do not
  // match Archon's shared four-root resolver, so accepting a `.claude`
  // match here would falsely imply that Codex can invoke it.
  if (capabilities?.skills !== false) {
    const skillScope = nodeSkillScope(validation, scope);
    for (const skillName of node.skills) {
      await validateSkill(validation, scope, skillScope, skillName);
    }
  }

  if (capabilities?.skills === false && node.skills.length > 0) {
    validation.issues.push({
      level: 'error',
      nodeId: node.id,
      field: 'skills',
      message: `Provider '${provider}' cannot load named skills — the run would fail before any node starts`,
      hint:
        provider === 'codex'
          ? 'Remove the skills field and invoke an installed Codex skill explicitly in the command or prompt with $skill-name'
          : 'Remove the skills field or switch to a provider whose skills capability is true',
    });
  }
}

function nodeSkillScope(
  validation: ResourceValidation,
  { node, provider, descriptor, capabilities }: NodeValidation
): SkillScope {
  const { cwd, config } = validation;
  const discovery = descriptor?.skillDiscovery;
  const env = config?.env;
  const nodeSources = 'settingSources' in node ? node.settingSources : undefined;
  const sources =
    provider !== undefined && capabilities?.settingSources
      ? (nodeSources ??
        parseSettingSources(config?.assistants?.[provider]?.settingSources) ??
        DEFAULT_SETTING_SOURCES)
      : undefined;
  const searchRoots = discovery
    ? declaredSkillRoots(discovery, cwd, {
        includeProject: sources?.includes('project') ?? true,
        includeUser: sources?.includes('user') ?? true,
        env,
      })
    : skillSearchRoots(cwd);
  const projectRoots = discovery
    ? declaredSkillRoots(discovery, cwd, { includeUser: false, env })
    : projectSkillSearchRoots(cwd);
  return { discovery, env, searchRoots, projectRoots };
}

async function validateSkill(
  validation: ResourceValidation,
  { node, provider, descriptor, capabilities }: NodeValidation,
  { discovery, env, searchRoots, projectRoots }: SkillScope,
  skillName: string
): Promise<void> {
  const { cwd, issues } = validation;
  for (const root of searchRoots) {
    if (!(await fileExists(join(root, skillName, 'SKILL.md')))) continue;
    if (!projectRoots.includes(root)) {
      issues.push({
        level: 'warning',
        nodeId: node.id,
        field: 'skills',
        message: `Skill '${skillName}' is available only in a host user directory`,
        hint: 'Execution scope is not known during validation. Container runs may not load host user skills; provider preflight checks availability for the run.',
      });
    }
    return;
  }

  // Mirror the declaring provider's rule (e.g. claude/node-config.ts): a
  // skill that exists under some other root is installed but
  // unreachable, so it is an error. A name that exists nowhere on disk
  // may be a built-in or `plugin:skill` entry the provider resolves
  // itself — warn there rather than failing a workflow that runs. Same
  // helper checks host paths; execution preflight owns run availability.
  const installedButUnusable =
    discovery !== undefined &&
    findInstalledSkillNames(
      [...searchRoots, ...skillSearchRoots(cwd), ...declaredSkillRoots(discovery, cwd, { env })],
      [skillName]
    ).length > 0;

  if (installedButUnusable) {
    const displayName = descriptor?.displayName ?? provider;
    const everyDeclaredRoot = declaredSkillRoots(discovery, cwd, { env });
    issues.push({
      level: 'error',
      nodeId: node.id,
      field: 'skills',
      message: `${displayName} skill '${skillName}' not found in an enabled skill directory, though it is installed elsewhere`,
      hint: `${displayName} loads skills only from ${everyDeclaredRoot.join(', ')}${capabilities?.settingSources ? ', in the scopes settingSources enables' : ''}. A skill is a directory containing SKILL.md`,
    });
    return;
  }
  issues.push({
    level: 'warning',
    nodeId: node.id,
    field: 'skills',
    message: `Skill '${skillName}' not found in ${searchRoots.join(', ') || 'any enabled skill directory'}`,
    hint: `Create ${join(searchRoots[0] ?? '<skill directory>', skillName, 'SKILL.md')} or check the spelling. Names the provider resolves itself, such as built-in or plugin skills, have no directory; a plugin:skill name also needs its plugin under plugins:`,
  });
}
