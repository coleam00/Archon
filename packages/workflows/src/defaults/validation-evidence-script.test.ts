import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  generation: number;
  reason: string;
  nonce: string;
}

async function run(
  cwd: string,
  artifacts: string,
  inputs: Record<string, string>
): Promise<string> {
  const { stdout } = await execFileAsync('bun', [script], {
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

async function check(cwd: string, artifacts: string, scope = ''): Promise<Applicability> {
  return JSON.parse(await run(cwd, artifacts, { action: 'check', scope })) as Applicability;
}

async function record(
  cwd: string,
  artifacts: string,
  applicability: Applicability,
  verdict: Record<string, unknown>
): Promise<void> {
  await run(cwd, artifacts, {
    action: 'record',
    applicability: JSON.stringify(applicability),
    verdict: JSON.stringify(verdict),
  });
}

const greenVerdict = {
  green: true,
  checks_performed: true,
  red_cause: '',
  summary: 'all checks passed',
};

async function repository(): Promise<{ cwd: string; artifacts: string }> {
  const root = await mkdtemp(join(tmpdir(), 'archon-validation-evidence-'));
  tempRoots.push(root);
  const cwd = join(root, 'repo');
  const artifacts = join(root, 'artifacts');
  await mkdir(cwd);
  await execFileAsync('git', ['init'], { cwd });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  await execFileAsync('git', ['config', 'user.name', 'Archon Test'], { cwd });
  await writeFile(join(cwd, 'source.ts'), 'export const value = 1;\n');
  await writeFile(join(cwd, 'evaluator.config'), 'strict=true\n');
  await execFileAsync('git', ['add', 'source.ts', 'evaluator.config'], { cwd });
  await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd });
  return { cwd, artifacts };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(removeTempTree));
});

describe('validation evidence applicability', () => {
  test('reuses unchanged successful evidence byte-for-byte', async () => {
    const { cwd, artifacts } = await repository();
    const first = await check(cwd, artifacts, 'packages/web');
    await record(cwd, artifacts, first, greenVerdict);

    expect(await check(cwd, artifacts, 'packages/web')).toEqual(first);
    expect(JSON.parse(await readFile(join(artifacts, 'validation-evidence.json'), 'utf8'))).toEqual(
      {
        applicability: first,
        verdict: greenVerdict,
      }
    );
  });

  test('invalidates changed tracked source, evaluator configuration, and scope', async () => {
    const { cwd, artifacts } = await repository();
    const first = await check(cwd, artifacts, 'packages/web');
    await record(cwd, artifacts, first, greenVerdict);

    await writeFile(join(cwd, 'source.ts'), 'export const value = 2;\n');
    const sourceChanged = await check(cwd, artifacts, 'packages/web');
    expect(sourceChanged).toMatchObject({ generation: 2, reason: 'tracked tree changed' });
    await record(cwd, artifacts, sourceChanged, greenVerdict);

    await writeFile(join(cwd, 'evaluator.config'), 'strict=false\n');
    const evaluatorChanged = await check(cwd, artifacts, 'packages/web');
    expect(evaluatorChanged).toMatchObject({ generation: 3, reason: 'tracked tree changed' });
    await record(cwd, artifacts, evaluatorChanged, greenVerdict);

    const scopeChanged = await check(cwd, artifacts, 'packages/core');
    expect(scopeChanged).toMatchObject({ generation: 4, reason: 'validation scope changed' });
  });

  test('invalidates missing, malformed, red, and unavailable evidence', async () => {
    const { cwd, artifacts } = await repository();
    const first = await check(cwd, artifacts);
    await record(cwd, artifacts, first, greenVerdict);

    await rm(join(artifacts, 'validation-evidence.json'));
    const missing = await check(cwd, artifacts);
    expect(missing).toMatchObject({ generation: 2, reason: 'validation evidence is missing' });
    await writeFile(join(artifacts, 'validation-evidence.json'), '{not-json');
    const malformed = await check(cwd, artifacts);
    expect(malformed.generation).toBe(3);

    await record(cwd, artifacts, malformed, {
      ...greenVerdict,
      green: false,
      red_cause: 'introduced',
    });
    const red = await check(cwd, artifacts);
    expect(red).toMatchObject({ generation: 4, reason: 'prior validation was not green' });

    await record(cwd, artifacts, red, { ...greenVerdict, checks_performed: false });
    const unavailable = await check(cwd, artifacts);
    expect(unavailable).toMatchObject({
      generation: 5,
      reason: 'prior validation performed no checks',
    });
  });

  test('invalidates when every applicability artifact is missing', async () => {
    const { cwd, artifacts } = await repository();
    const first = await check(cwd, artifacts);
    await record(cwd, artifacts, first, greenVerdict);
    await rm(join(artifacts, '.validation-applicability.json'));
    await rm(join(artifacts, 'validation-evidence.json'));

    const rebuilt = await check(cwd, artifacts);
    expect(rebuilt).not.toEqual(first);
    expect(rebuilt).toMatchObject({ generation: 1, reason: 'first validation for this run' });
  });
});
