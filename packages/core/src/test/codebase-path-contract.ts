import { expect } from 'bun:test';
import { resolve } from 'node:path';
import { toBranchName } from '@archon/git';
import { setPlatformPolicies } from '../platforms/registry';
import type { IDatabase } from '../db/adapters/types';

export async function verifyCodebasePathContract(db: IDatabase): Promise<void> {
  setPlatformPolicies([]);
  const codebases = await import('../db/codebases');
  const environments = await import('../db/isolation-environments');
  const absolutePath = resolve('project-path-contract');
  for (const default_cwd of ['projects/repo', '', './repo', '~/repo']) {
    await expect(codebases.createCodebase({ name: 'invalid', default_cwd })).rejects.toBeInstanceOf(
      codebases.InvalidCodebaseDefaultCwdError
    );
  }
  const project = await codebases.createCodebase({
    name: 'Client "Ops"',
    default_cwd: absolutePath,
    kind: 'folder',
    repository_url: 'https://example.test/repo',
    default_branch: 'main',
  });
  await codebases.updateCodebaseCommands(project.id, {
    probe: { path: 'probe.md', description: 'Probe' },
  });
  const env = await environments.create({
    codebase_id: project.id,
    workflow_type: 'task',
    workflow_id: 'path-contract',
    working_path: absolutePath,
    branch_name: toBranchName('path-contract'),
    created_by_platform: 'cli',
    metadata: { key: 'value' },
  });
  await db.query('UPDATE remote_agent_isolation_environments SET created_at = $1 WHERE id = $2', [
    '2000-01-01 00:00:00',
    env.id,
  ]);
  await expect(
    codebases.updateCodebase(project.id, { default_cwd: './repo' })
  ).rejects.toBeInstanceOf(codebases.InvalidCodebaseDefaultCwdError);
  expect((await codebases.getCodebase(project.id))?.default_cwd).toBe(absolutePath);
  await db.query('UPDATE remote_agent_codebases SET default_cwd = $1 WHERE id = $2', [
    'projects/repo',
    project.id,
  ]);
  for (const read of [
    () => codebases.getCodebase(project.id),
    () => codebases.findCodebaseByName(project.name),
    () => codebases.findCodebaseByRepoUrl('https://example.test/repo'),
    () => codebases.findCodebaseByDefaultCwd('projects/repo'),
    () => codebases.findCodebaseByPathPrefix(absolutePath),
    () => codebases.listCodebases(),
    () => environments.findStaleEnvironments(7),
    () => environments.findActiveByBranchName('path-contract'),
    () => environments.listAllActiveWithCodebase(),
  ]) {
    await expect(read()).rejects.toBeInstanceOf(codebases.InvalidCodebaseDefaultCwdError);
  }
  expect(await codebases.listCodebaseRegistrations()).toEqual([
    {
      id: project.id,
      name: project.name,
      stored_default_cwd: 'projects/repo',
    },
  ]);
  const stored = await db.query<{ default_cwd: string }>(
    'SELECT default_cwd FROM remote_agent_codebases WHERE id = $1',
    [project.id]
  );
  expect(stored.rows[0]?.default_cwd).toBe('projects/repo');
  await codebases.updateCodebase(project.id, { default_cwd: absolutePath });
  expect(await codebases.getCodebase(project.id)).toMatchObject({
    id: project.id,
    name: project.name,
    kind: 'folder',
    default_cwd: absolutePath,
    repository_url: project.repository_url,
    default_branch: project.default_branch,
  });
  expect(await codebases.getCodebaseCommands(project.id)).toEqual({
    probe: { path: 'probe.md', description: 'Probe' },
  });
  expect((await environments.findStaleEnvironments(7))[0]?.codebase_name).toBe(project.name);
  expect((await environments.findActiveByBranchName('path-contract'))?.metadata).toEqual({
    key: 'value',
  });
  expect((await environments.listAllActiveWithCodebase())[0]?.codebase_default_cwd).toBe(
    absolutePath
  );
}
