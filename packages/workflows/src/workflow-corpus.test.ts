import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { removeTempTree } from '@archon/paths/test-utils';
import { registerBuiltinProviders, registerCommunityProviders } from '@archon/providers';
import { validationSourceConfigSchema, workflowValidationConfig } from './validation-config';
import { discoverWorkflowsWithConfig } from './workflow-discovery';
import { validateWorkflowResources, type ValidationIssue } from './validator';

const repo = resolve(import.meta.dir, '../../..');
const root = await mkdtemp(join(tmpdir(), 'archon-workflow-corpus-'));
const originalHome = process.env.ARCHON_HOME;
process.env.ARCHON_HOME = join(root, 'home');
registerBuiltinProviders();
registerCommunityProviders();
afterAll(async () => {
  if (originalHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalHome;
  await removeTempTree(root);
});

interface Finding {
  file: string;
  issue: ValidationIssue;
}

function workflowSourceFiles(paths: string[]): string[] {
  return paths
    .map(file => file.replaceAll('\\', '/'))
    .filter(file => !file.split('/').includes('fixtures'))
    .sort();
}

async function validateCorpus(cwd: string): Promise<{ findings: Finding[]; files: string[] }> {
  const configPath = join(cwd, '.archon/config.yaml');
  const config = validationSourceConfigSchema.parse(
    (await Bun.file(configPath).exists()) ? Bun.YAML.parse(await readFile(configPath, 'utf8')) : {}
  );
  const workflowRoot = join(cwd, '.archon/workflows');
  const files = workflowSourceFiles(
    await Array.fromAsync(new Bun.Glob('**/*.{yaml,yml}').scan(workflowRoot))
  );
  const fileByName = new Map<string, string>();
  for (const file of files) {
    const value = z
      .object({ name: z.string() })
      .safeParse(Bun.YAML.parse(await readFile(join(workflowRoot, file), 'utf8')));
    if (value.success) fileByName.set(value.data.name, file);
  }
  const discovered = await discoverWorkflowsWithConfig(cwd, async () => ({
    ...config,
    envVars: config.env,
  }));
  const findings: Finding[] = discovered.errors.map(error => ({
    file:
      files.find(file => file.endsWith('/' + error.filename) || file === error.filename) ??
      error.filename,
    issue: { level: 'error', field: error.errorType, message: error.error },
  }));
  const checkedFiles = new Set(findings.map(finding => finding.file));
  for (const { workflow, source } of discovered.workflows) {
    const file = fileByName.get(workflow.name);
    // Bundled workflows also appear when validating scratch projects.
    if (file === undefined) continue;
    checkedFiles.add(file);
    const issues = await validateWorkflowResources(
      workflow,
      cwd,
      {
        ...workflowValidationConfig(config),
        workflowSource: source,
      },
      config.assistant
    );
    findings.push(
      ...issues
        .filter(issue => issue.level === 'error' || issue.code === 'shell_output_ref')
        .map(issue => ({ file, issue }))
    );
  }
  expect(files.filter(file => !checkedFiles.has(file))).toEqual([]);
  return { findings, files };
}

test('repository workflows have no errors or unsafe shell output references', async () => {
  const { findings, files } = await validateCorpus(repo);
  expect(files.length).toBeGreaterThan(0);
  expect(files.some(file => file.startsWith('sdlc/'))).toBe(true);
  expect(findings).toEqual([]);
});

test('corpus inventory excludes fixtures and identifies SDLC sources with either path separator', () => {
  const paths = [
    'sdlc/deliver/fixtures/clean.stubs.yaml',
    'sdlc/deliver/archon-deliver.yaml',
    'scratch.yml',
  ];
  const expected = ['scratch.yml', 'sdlc/deliver/archon-deliver.yaml'];
  expect(workflowSourceFiles(paths)).toEqual(expected);
  expect(workflowSourceFiles(paths.map(file => file.replaceAll('/', '\\')))).toEqual(expected);
});

test.each<[string, string, ValidationIssue['code']]>([
  ['quoted', 'echo "$source.output"', 'shell_output_ref'],
  ['bare', 'echo $source.output', 'shell_output_ref'],
  ['unknown', 'value=$missing.output', undefined],
])('rejects a discovered workflow with %s output references', async (name, body, code) => {
  const project = join(root, name);
  const folder = join(project, '.archon/workflows');
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, 'broken.yaml'),
    `name: corpus-${name}
description: scratch corpus
nodes:
  - id: source
    bash: echo hello
  - id: use
    depends_on: [source]
    bash: '${body}'
`
  );
  const { findings } = await validateCorpus(project);
  expect(findings).toHaveLength(1);
  expect(findings[0].file).toBe('broken.yaml');
  if (code) expect(findings[0].issue.code).toBe(code);
  else expect(findings[0].issue.level).toBe('error');
  expect(() => expect(findings).toEqual([])).toThrow();
});

test.each(['project', 'custom-user'])(
  'honours Claude configuration for a %s skill',
  async scope => {
    const project = join(root, `skill-${scope}`);
    const folder = join(project, '.archon/workflows');
    const configDir = join(project, 'custom-claude');
    const skillDir = join(
      scope === 'project' ? join(project, '.claude') : configDir,
      'skills',
      'corpus-skill'
    );
    await mkdir(folder, { recursive: true });
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# Corpus skill\n');
    await writeFile(
      join(folder, 'skill.yaml'),
      `name: corpus-skill-${scope}\ndescription: scratch skill corpus\nprovider: claude\nnodes:\n  - id: use\n    prompt: use the skill\n    skills: [corpus-skill]\n`
    );
    const configPath = join(project, '.archon/config.yaml');
    const config = {
      assistants: { claude: { settingSources: [scope === 'project' ? 'user' : 'project'] } },
      env: { CLAUDE_CONFIG_DIR: configDir },
    };
    await writeFile(configPath, Bun.YAML.stringify(config));
    const { findings } = await validateCorpus(project);
    expect(findings).toHaveLength(1);
    expect(findings[0].issue.field).toBe('skills');
    expect(findings[0].issue.level).toBe('error');
    config.assistants.claude.settingSources = [scope === 'project' ? 'project' : 'user'];
    await writeFile(configPath, Bun.YAML.stringify(config));
    expect((await validateCorpus(project)).findings).toEqual([]);
  }
);
