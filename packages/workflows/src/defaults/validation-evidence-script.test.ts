import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { removeTempTree } from '@archon/paths/test-utils';

const execFileAsync = promisify(execFile);
const script = resolve(
  import.meta.dir,
  '../../../../.archon/workflows/sdlc/validate/scripts/validation-evidence.ts'
);
const tempRoots: string[] = [];

interface Applicability {
  fingerprint: string;
  scope: string;
  context: string;
  validator: string;
  generation: number;
  reason: string;
  nonce: string;
  reuse: boolean;
}

const greenVerdict = {
  green: true,
  checks_performed: true,
  red_cause: '',
  summary: 'all checks passed',
};

async function run(
  cwd: string,
  artifacts: string,
  inputs: Record<string, string>,
  scriptPath = script
): Promise<string> {
  const { stdout } = await execFileAsync('bun', [scriptPath], {
    cwd,
    env: {
      ...process.env,
      ARTIFACTS_DIR: artifacts,
      ...Object.fromEntries(
        Object.entries(inputs).map(([key, value]) => [`INPUTS_${key.toUpperCase()}`, value])
      ),
    },
  });
  return stdout.trim();
}

async function check(
  cwd: string,
  artifacts: string,
  scope = '',
  context = '',
  scriptPath = script
): Promise<Applicability> {
  return JSON.parse(
    await run(cwd, artifacts, { action: 'check', scope, context }, scriptPath)
  ) as Applicability;
}

async function record(
  cwd: string,
  artifacts: string,
  applicability: Applicability,
  verdict: Record<string, unknown> = greenVerdict,
  report = 'bun run validate: passed\n',
  scriptPath = script
): Promise<void> {
  await writeFile(join(artifacts, 'validation.md'), report);
  await run(
    cwd,
    artifacts,
    {
      action: 'record',
      applicability: JSON.stringify(applicability),
      verdict: JSON.stringify(verdict),
    },
    scriptPath
  );
}

async function repository(): Promise<{ cwd: string; artifacts: string }> {
  const root = await mkdtemp(join(tmpdir(), 'archon-validation-evidence-'));
  tempRoots.push(root);
  const cwd = join(root, 'repo');
  const artifacts = join(root, 'artifacts');
  await mkdir(cwd);
  await mkdir(artifacts);
  await execFileAsync('git', ['init'], { cwd });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  await execFileAsync('git', ['config', 'user.name', 'Archon Test'], { cwd });
  await writeFile(join(cwd, 'source.ts'), 'export const value = 1;\n');
  await execFileAsync('git', ['add', 'source.ts'], { cwd });
  await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd });
  return { cwd, artifacts };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(removeTempTree));
});

describe('validation evidence applicability', () => {
  test('reuses a green verdict only with its exact nonempty report', async () => {
    const { cwd, artifacts } = await repository();
    const first = await check(cwd, artifacts, 'packages/web');
    await record(cwd, artifacts, first);

    const reusable = await check(cwd, artifacts, 'packages/web');
    expect(reusable).toMatchObject({
      fingerprint: first.fingerprint,
      generation: first.generation,
      nonce: first.nonce,
      reuse: true,
      reason: 'applicable evidence',
    });
    expect(await check(cwd, artifacts, 'packages/web')).toEqual(reusable);
    expect(JSON.parse(await readFile(join(artifacts, 'validation-evidence.json'), 'utf8'))).toEqual(
      {
        applicability: first,
        verdict: greenVerdict,
        report: {
          sha256: 'e37e1de5075ca27a66d373e77b39d038ca27d54ee9b93e7ff53ba64bfc88c7da',
          content: 'bun run validate: passed\n',
        },
      }
    );

    await writeFile(join(artifacts, 'validation.md'), 'changed report\n');
    expect(await check(cwd, artifacts, 'packages/web')).toMatchObject({
      generation: 2,
      reason: 'validation report changed',
      reuse: false,
    });
  });

  test('invalidates changed tracked source, scope, and external context', async () => {
    const { cwd, artifacts } = await repository();
    const first = await check(cwd, artifacts, 'packages/web', 'db:snapshot-1');
    await record(cwd, artifacts, first);

    await writeFile(join(cwd, 'source.ts'), 'export const value = 2;\n');
    const sourceChanged = await check(cwd, artifacts, 'packages/web', 'db:snapshot-1');
    expect(sourceChanged).toMatchObject({ generation: 2, reason: 'tracked tree changed' });
    await record(cwd, artifacts, sourceChanged);

    const scopeChanged = await check(cwd, artifacts, 'packages/core', 'db:snapshot-1');
    expect(scopeChanged).toMatchObject({ generation: 3, reason: 'validation scope changed' });
    await record(cwd, artifacts, scopeChanged);

    const contextChanged = await check(cwd, artifacts, 'packages/core', 'db:snapshot-2');
    expect(contextChanged).toMatchObject({ generation: 4, reason: 'validation context changed' });
  });

  test('invalidates when the packaged validator source changes', async () => {
    const { cwd, artifacts } = await repository();
    const validatorDir = join(artifacts, 'validator');
    const copiedScript = join(validatorDir, 'scripts', 'validation-evidence.ts');
    const copiedCommand = join(validatorDir, 'commands', 'validate.md');
    const copiedWorkflow = join(validatorDir, 'archon-validate.yaml');
    await mkdir(join(validatorDir, 'scripts'), { recursive: true });
    await mkdir(join(validatorDir, 'commands'), { recursive: true });
    await copyFile(script, copiedScript);
    await copyFile(
      resolve(import.meta.dir, '../../../../.archon/workflows/sdlc/validate/commands/validate.md'),
      copiedCommand
    );
    await copyFile(
      resolve(import.meta.dir, '../../../../.archon/workflows/sdlc/validate/archon-validate.yaml'),
      copiedWorkflow
    );

    const first = await check(cwd, artifacts, '', '', copiedScript);
    await record(cwd, artifacts, first, greenVerdict, 'passed\n', copiedScript);
    await writeFile(copiedCommand, 'changed evaluator source\n');

    expect(await check(cwd, artifacts, '', '', copiedScript)).toMatchObject({
      generation: 2,
      reason: 'validator changed',
      reuse: false,
    });
  });

  test('invalidates missing report/evidence and non-green or checkless verdicts', async () => {
    const { cwd, artifacts } = await repository();
    const first = await check(cwd, artifacts);
    await record(cwd, artifacts, first);

    await rm(join(artifacts, 'validation.md'));
    const missingReport = await check(cwd, artifacts);
    expect(missingReport).toMatchObject({
      generation: 2,
      reason: 'validation report is missing or empty',
    });
    await record(cwd, artifacts, missingReport);

    await rm(join(artifacts, 'validation-evidence.json'));
    const missingEvidence = await check(cwd, artifacts);
    expect(missingEvidence).toMatchObject({
      generation: 3,
      reason: 'validation evidence is missing',
    });
    await record(cwd, artifacts, missingEvidence, {
      ...greenVerdict,
      green: false,
      red_cause: 'introduced',
    });

    const red = await check(cwd, artifacts);
    expect(red).toMatchObject({ generation: 4, reason: 'prior validation was not green' });
    await record(cwd, artifacts, red, { ...greenVerdict, checks_performed: false });
    expect(await check(cwd, artifacts)).toMatchObject({
      generation: 5,
      reason: 'prior validation performed no checks',
    });
  });

  test('record refuses a missing report and a tree changed during validation', async () => {
    const { cwd, artifacts } = await repository();
    const applicability = await check(cwd, artifacts);
    await expect(
      run(cwd, artifacts, {
        action: 'record',
        applicability: JSON.stringify(applicability),
        verdict: JSON.stringify(greenVerdict),
      })
    ).rejects.toThrow('validation.md is missing or empty');

    await writeFile(join(artifacts, 'validation.md'), 'passed before mutation\n');
    await writeFile(join(cwd, 'source.ts'), 'export const value = 3;\n');
    await expect(
      run(cwd, artifacts, {
        action: 'record',
        applicability: JSON.stringify(applicability),
        verdict: JSON.stringify(greenVerdict),
      })
    ).rejects.toThrow('tracked tree changed while validation was running');
  });
});
