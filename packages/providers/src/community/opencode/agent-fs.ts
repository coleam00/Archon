import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { NodeConfig } from '../../types';

import { toKebabCase } from './agent-config';

type AgentConfig = NonNullable<NonNullable<NodeConfig['agents']>[string]>;

function buildAgentFileContent(agentConfig: AgentConfig): string {
  const lines: string[] = ['---'];

  lines.push('mode: subagent');

  if (agentConfig.description) {
    lines.push(`description: ${JSON.stringify(agentConfig.description)}`);
  }

  if (agentConfig.model) {
    lines.push(`model: ${JSON.stringify(agentConfig.model)}`);
  }

  if (typeof agentConfig.maxTurns === 'number') {
    lines.push(`steps: ${agentConfig.maxTurns}`);
  }

  if (agentConfig.skills && agentConfig.skills.length > 0) {
    lines.push('skills:');
    for (const skill of agentConfig.skills) {
      lines.push(`- ${JSON.stringify(skill)}`);
    }
  }

  const toolsMap: Record<string, boolean> = {};
  for (const tool of agentConfig.tools ?? []) {
    toolsMap[tool] = true;
  }
  for (const tool of agentConfig.disallowedTools ?? []) {
    toolsMap[tool] = false;
  }
  if (Object.keys(toolsMap).length > 0) {
    lines.push('tools:');
    for (const [tool, allowed] of Object.entries(toolsMap)) {
      lines.push(`  ${tool}: ${allowed}`);
    }
  }

  lines.push('---');

  if (agentConfig.prompt) {
    lines.push('');
    lines.push(agentConfig.prompt);
  }

  return lines.join('\n');
}

export async function materializeAgents(
  cwd: string,
  agents: Record<string, AgentConfig>
): Promise<void> {
  const agentsDir = join(cwd, '.opencode', 'agents');
  await mkdir(agentsDir, { recursive: true });

  // Remove stale archon-owned agent files that aren't in the current request
  const currentArchonFiles = new Set(
    Object.keys(agents).map(key => `archon-${toKebabCase(key)}.md`)
  );
  try {
    const existing = await readdir(agentsDir);
    await Promise.all(
      existing
        .filter(f => f.startsWith('archon-') && !currentArchonFiles.has(f))
        .map(f => rm(join(agentsDir, f), { force: true }))
    );
  } catch {
    // Directory might not exist yet — mkdir above handles that
  }

  // Write all agent files for this request
  await Promise.all(
    Object.entries(agents).map(([key, config]) => {
      const filename = `archon-${toKebabCase(key)}.md`;
      const content = buildAgentFileContent(config);
      return writeFile(join(agentsDir, filename), content, 'utf8');
    })
  );
}
