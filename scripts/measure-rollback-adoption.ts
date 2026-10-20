import { execFileSync } from 'node:child_process';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [baselineRevision, output] = process.argv.slice(2);
if (!baselineRevision || !output)
  throw new Error('Pass a baseline revision and an output directory for the rollback measurements');
const outputDir = resolve(output);
await mkdir(outputDir, { recursive: true });

const testDir = 'packages/core/src/workflows';
const baselinePath = `${testDir}/registered-worktree.before.integration.test.ts`;
const baseline = execFileSync('git', [
  'show',
  `${baselineRevision}:${testDir}/registered-worktree.integration.test.ts`,
]);
await writeFile(baselinePath, baseline, { flag: 'wx' });
try {
  // Reverse the second pair so a warming cache does not always favor the same version.
  for (const [index, version] of ['before', 'after', 'after', 'before'].entries()) {
    const label = `${String(index + 1)}-${version}`;
    const tracePath = join(outputDir, `${label}.git.jsonl`);
    const junitPath = join(outputDir, `${label}.xml`);
    await writeFile(tracePath, '');
    const selector = `src/workflows/registered-worktree${version === 'before' ? '.before' : ''}.integration.test.ts`;
    console.log(`Rollback comparison ${label}; baseline ${baselineRevision}`);
    const child = Bun.spawn(
      [
        process.execPath,
        'run',
        '--cwd',
        'packages/core',
        'test',
        selector,
        '--reporter=junit',
        `--reporter-outfile=${junitPath}`,
      ],
      {
        env: { ...process.env, GIT_TRACE2_EVENT: tracePath },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await writeFile(join(outputDir, `${label}.log`), stdout + stderr);
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    if (code !== 0)
      throw new Error(`Rollback comparison ${label} failed with exit ${String(code)}`);
    console.log(
      `Rollback comparison ${label} per-test timings:\n${await readFile(junitPath, 'utf8')}`
    );
  }
} finally {
  await unlink(baselinePath);
}
