import { execFileSync } from 'node:child_process';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';

const [baselineRevision, output] = process.argv.slice(2);
if (!baselineRevision || !output)
  throw new Error('Pass a baseline revision and an output directory for the rollback measurements');
const outputDir = resolve(output);
await mkdir(outputDir, { recursive: true });

const packageDir = 'packages/core';
const testDir = `${packageDir}/src/workflows`;
const currentPath = `${testDir}/registered-worktree.integration.test.ts`;
const baselinePath = `${testDir}/registered-worktree.before.integration.test.ts`;
const baseline = execFileSync('git', ['show', `${baselineRevision}:${currentPath}`]);
await writeFile(baselinePath, baseline, { flag: 'wx' });
try {
  const failures: string[] = [];
  // Reverse the second pair so a warming cache does not always favor the same version.
  for (const [index, version] of ['before', 'after', 'after', 'before'].entries()) {
    const label = `${String(index + 1)}-${version}`;
    const tracePath = join(outputDir, `${label}.git.jsonl`);
    const junitPath = join(outputDir, `${label}.xml`);
    await writeFile(tracePath, '');
    const selector = posix.relative(packageDir, version === 'before' ? baselinePath : currentPath);
    console.log(`Rollback comparison ${label}; baseline ${baselineRevision}`);
    const child = Bun.spawn(
      [
        process.execPath,
        'run',
        '--cwd',
        packageDir,
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
    if (code !== 0) {
      failures.push(`${label} (exit ${String(code)})`);
      continue;
    }
    console.log(
      `Rollback comparison ${label} per-test timings:\n${await readFile(junitPath, 'utf8')}`
    );
  }
  if (failures.length > 0) throw new Error(`Rollback comparisons failed: ${failures.join(', ')}`);
} finally {
  await unlink(baselinePath);
}
