import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { removeTempTree } from '@archon/paths/test-utils';
import { registerBuiltinProviders, registerCommunityProviders } from '@archon/providers';
import { rawAliasesConfigSchema, rawTiersConfigSchema } from './schemas/model-binding';
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

const configSchema = z.object({
  assistant: z.string().default('claude'),
  aliases: rawAliasesConfigSchema.optional(),
  tiers: rawTiersConfigSchema.optional(),
  defaults: z
    .object({
      loadDefaultWorkflows: z.boolean().optional(),
      loadDefaultCommands: z.boolean().optional(),
    })
    .optional(),
  commands: z.object({ folder: z.string().optional() }).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

interface Finding {
  file: string;
  issue: ValidationIssue;
}

interface Allowance extends Finding {
  reason: string;
}

const allowlist: readonly Allowance[] = [];

function assertCorpus(findings: readonly Finding[], allowances = allowlist): void {
  for (const allowance of allowances) {
    expect(allowance.reason.trim().length).toBeGreaterThan(0);
    expect(allowance.file.startsWith('sdlc/')).toBe(false);
    expect(findings).toContainEqual({ file: allowance.file, issue: allowance.issue });
  }
  const unexpected = findings.filter(
    finding =>
      !allowances.some(
        allowance =>
          allowance.file === finding.file && isDeepStrictEqual(allowance.issue, finding.issue)
      )
  );
  expect(unexpected).toEqual([]);
}

async function validateCorpus(cwd: string): Promise<{ findings: Finding[]; files: string[] }> {
  const configPath = join(cwd, '.archon/config.yaml');
  const config = configSchema.parse(
    (await Bun.file(configPath).exists()) ? Bun.YAML.parse(await readFile(configPath, 'utf8')) : {}
  );
  const workflowRoot = join(cwd, '.archon/workflows');
  const files = (await Array.fromAsync(new Bun.Glob('**/*.{yaml,yml}').scan(workflowRoot)))
    .filter(file => !file.split('/').includes('fixtures'))
    .sort();
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
        workflowSource: source,
        assistant: config.assistant,
        aliases: config.aliases,
        tiers: config.tiers,
        loadDefaultCommands: config.defaults?.loadDefaultCommands,
        commandFolder: config.commands?.folder,
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
  assertCorpus(findings);
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
  expect(() => assertCorpus(findings)).toThrow();
  const allowance = { ...findings[0], reason: 'Synthetic finding to exercise allowlist matching' };
  assertCorpus(findings, [allowance]);
  expect(() => assertCorpus([], [allowance])).toThrow();
  expect(() =>
    assertCorpus(
      [{ ...findings[0], file: 'sdlc/broken.yaml' }],
      [{ ...allowance, file: 'sdlc/broken.yaml' }]
    )
  ).toThrow();
});
