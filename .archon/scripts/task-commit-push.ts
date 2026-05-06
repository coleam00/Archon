#!/usr/bin/env bun
/**
 * Stage test-shaped files only, commit with a [test-gen] message, and push.
 *
 * Files allowed in this commit:
 *   tests/**, test/**, e2e/**, __tests__/**
 *   *.test.{ts,tsx,js,jsx,mjs,cjs}
 *   *.spec.{ts,tsx,js,jsx,mjs,cjs}
 *   *.config.ts/js for test runners (playwright, vitest, jest)
 *   docs/contracts/<issue-key>.md — the technical contract authored
 *     upstream of test generation. Lives in the project repo as normal
 *     documentation (it describes the project's interface contract for
 *     a given ticket). Committing it here means task-implement (running
 *     in a different ARTIFACTS_DIR) reads it directly off disk in the
 *     same per-ticket branch.
 *   package.json — for adding test devDependencies (allowed; dev workflow may add more)
 *   pnpm-lock.yaml / package-lock.json / bun.lockb — lockfile updates accompanying deps
 *
 * Any non-test edits are discarded so downstream dev starts clean.
 *
 * Reads:
 *   $ARTIFACTS_DIR/trigger-payload.json — for issue_key in commit message
 *   $ARTIFACTS_DIR/task.raw.json — for ticket summary in commit message
 *
 * stdout: { committed, pushed, sha, files }
 */
import { readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const artifactsDir = process.env.ARTIFACTS_DIR;
if (!artifactsDir) {
  console.error('ARTIFACTS_DIR not set');
  process.exit(1);
}

const trigger = JSON.parse(
  await readFile(`${artifactsDir}/trigger-payload.json`, 'utf8')
) as { issue_key: string };

let summary = trigger.issue_key;
try {
  const task = JSON.parse(await readFile(`${artifactsDir}/task.raw.json`, 'utf8')) as {
    fields: { summary: string };
  };
  summary = task.fields.summary;
} catch {
  // task.raw.json optional; fall back to issue key only
}

async function git(...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: process.cwd(),
      maxBuffer: 50 * 1024 * 1024,
    });
    return stdout;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const detail = (err.stderr || err.stdout || err.message || String(e)).trim();
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
}

const ALLOWED_PATTERNS = [
  /(^|\/)tests?\//,
  /(^|\/)e2e\//,
  /(^|\/)__tests__\//,
  /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/,
  /(^|\/)(playwright|vitest|jest)\.config\.(ts|js|mjs|cjs)$/,
  /^docs\/contracts\/.+\.md$/,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^pnpm-lock\.yaml$/,
  /^bun\.lockb$/,
];

// -uall expands untracked directories into their individual files.
// Without it, an untracked `docs/contracts/wor-N/` dir would show as a
// single line `?? docs/contracts/wor-N/` and never match the per-file
// regex below, then get swept into `skipped` and silently rm'd by the
// cleanup loop. This was the root cause of contracts vanishing between
// create-contract and the test-gen commit. (Same fix the
// task-verify-tests-exist.ts script already had.)
const statusOut = (await git('status', '--porcelain', '-uall')).split('\n').filter(Boolean);
const changed = statusOut.map(line => ({ status: line.slice(0, 2), path: line.slice(3).trim() }));

console.log(`${changed.length} changed files in working tree.`);

const toStage = changed.filter(c => ALLOWED_PATTERNS.some(re => re.test(c.path)));
const skipped = changed.filter(c => !toStage.includes(c));

if (toStage.length === 0) {
  console.error('No test-shaped files to commit. Aborting.');
  process.exit(1);
}

console.log(`Staging ${toStage.length} test-shaped file(s):`);
for (const c of toStage) console.log(`  + ${c.path}`);
if (skipped.length > 0) {
  console.log(`Discarding ${skipped.length} non-test file(s) to keep branch clean:`);
  for (const c of skipped) console.log(`  - ${c.path}`);
}

await git('add', '--', ...toStage.map(c => c.path));

// Normalize worktree state before commit so task-implement can rebase cleanly.
for (const c of skipped) {
  if (c.status === '??') {
    await rm(c.path, { force: true, recursive: true });
    continue;
  }
  await git('restore', '--worktree', '--staged', '--', c.path);
}

const message = `[test-gen] ${trigger.issue_key}: tests for "${summary}"`;
console.log(`Committing: ${message}`);
await git('commit', '-m', message);

const sha = (await git('rev-parse', 'HEAD')).trim();
const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).trim();
console.log(`Commit ${sha.slice(0, 8)} created on branch ${branch}.`);

console.log(`Pushing ${branch} to origin (-u to set upstream)...`);
await git('push', '-u', 'origin', branch);
console.log('Pushed.');

process.stdout.write(
  '\n' +
    JSON.stringify({
      committed: true,
      pushed: true,
      branch,
      sha,
      files: toStage.map(c => c.path),
    })
);
