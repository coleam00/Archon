/**
 * The intake bench: compare intake and triage versions on issues whose outcome is
 * already known, in batches of five, writing nothing to the issues.
 *
 *   bench.ts select --repo <host/owner/name> --set <set.json> [--dispositions <file.json>]
 *                   [--duplicates 10] [--fixed 20] [--not-planned 25] [--typed 20] [--outside 15]
 *   bench.ts run    --set <set.json> --batch <n> --version <v.yaml>... --out <dir>
 *                   [--base <commit>] [--concurrency <n>] [--live <live.yaml>]
 *   bench.ts copy   --set <set.json> --batch <n> --live <live.yaml> --out <dir>
 *   bench.ts score  --set <set.json> --out <dir>
 *   bench.ts page   --set <set.json> --batch <n> --out <dir> [--port 0] [--print]
 *
 * Run it from a checkout of the set's repository. The set, the dispositions file and
 * the output directory are the operator's and live outside the pack. A version file
 * is `{label, pack_sha}` for the baseline, plus `provider` and `model` for any other.
 * A live file maps each version label to `{repo: {host, path}, checkout}`, a scratch
 * repository the operator prepared and a checkout of it at the batch base.
 */

import { mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isId } from '../../../.shared/bench.ts';
import { gitOrThrow } from '../../../.shared/git.ts';
import { renderPage, servePage } from './page.ts';
import {
  type BatchOptions,
  checkScratch,
  copyRows,
  evalCheckout,
  loadLive,
  readCopies,
  resolveVersion,
  runBatch,
} from './runner.ts';
import { renderScore, score } from './score.ts';
import { batchRows, loadSet, parseDispositions, selectSet } from './set.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    set: { type: 'string' },
    repo: { type: 'string' },
    out: { type: 'string' },
    batch: { type: 'string' },
    version: { type: 'string', multiple: true },
    base: { type: 'string' },
    concurrency: { type: 'string' },
    live: { type: 'string' },
    dispositions: { type: 'string' },
    duplicates: { type: 'string', default: '10' },
    fixed: { type: 'string', default: '20' },
    'not-planned': { type: 'string', default: '25' },
    typed: { type: 'string', default: '20' },
    outside: { type: 'string', default: '15' },
    port: { type: 'string', default: '0' },
    print: { type: 'boolean', default: false },
  },
});

function required(name: string, value: string | undefined): string {
  if (value === undefined || value === '') throw new Error(`--${name} is required`);
  return value;
}

function count(name: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`--${name} must be a whole number`);
  return parsed;
}

function atLeastOne(name: string, value: string | undefined): number {
  const parsed = count(name, value);
  if (parsed === 0) throw new Error(`--${name} must be at least 1`);
  return parsed;
}

async function main(): Promise<void> {
  const command = positionals[0];
  const repoRoot = gitOrThrow('rev-parse', '--show-toplevel');
  const setFile = resolve(required('set', values.set));

  if (command === 'select') {
    const [host, ...path] = required('repo', values.repo).split('/');
    const set = selectSet(
      { host, path: path.join('/') },
      setFile,
      {
        duplicate: count('duplicates', values.duplicates),
        fixed: count('fixed', values.fixed),
        not_planned: count('not-planned', values['not-planned']),
        typed: count('typed', values.typed),
        outside: count('outside', values.outside),
      },
      values.dispositions === undefined ? new Map() : parseDispositions(resolve(values.dispositions))
    );
    console.log(`pinned ${String(set.rows.length)} rows to ${setFile}`);
    return;
  }

  const set = loadSet(setFile);
  const outDir = resolve(required('out', values.out));
  // Checkouts and results land here; inside the repository they would be its untracked files.
  if (!relative(repoRoot, outDir).startsWith('..') && !isAbsolute(relative(repoRoot, outDir))) {
    throw new Error(`--out ${outDir} is inside the repository; results live outside it`);
  }
  mkdirSync(outDir, { recursive: true });

  if (command === 'score') {
    process.stdout.write(renderScore(score(set, outDir)));
    return;
  }

  const batch = count('batch', required('batch', values.batch));
  const rows = batchRows(set, batch);

  if (command === 'page') {
    if (values.print) {
      process.stdout.write(renderPage(set, outDir, batch));
      return;
    }
    console.log(`batch ${String(batch)} evaluation page: ${servePage(set, outDir, batch, count('port', values.port))}`);
    return;
  }

  const live = values.live === undefined ? undefined : loadLive(resolve(values.live), set);

  if (command === 'copy') {
    if (live === undefined) throw new Error('--live is required');
    for (const [label, scratch] of live) {
      const copies = copyRows(outDir, label, scratch, rows);
      console.log(`${label}: ${rows.map(row => `${row.id} → ${scratch.repo.path}#${String(copies[row.id])}`).join(', ')}`);
    }
    return;
  }

  if (command === 'run') {
    const versionFiles = values.version ?? [];
    if (versionFiles.length === 0) throw new Error('name at least one --version');
    const base = gitOrThrow('rev-parse', '--verify', `${values.base ?? 'HEAD'}^{commit}`);
    const versions: { label: string; file: string; cwd: string }[] = [];
    for (const file of versionFiles.map(entry => resolve(entry))) {
      const label = (Bun.YAML.parse(await Bun.file(file).text()) as { label?: unknown }).label;
      // The label names this version's checkout directory, so it is checked before any path is built from it.
      if (!isId(label)) throw new Error(`${file}: \`label\` must be letters, digits, \`.\`, \`_\` or \`-\``);
      const scratch = live?.get(label);
      if (live !== undefined && scratch === undefined) throw new Error(`${label} has no scratch repository in --live`);
      if (scratch !== undefined) checkScratch(label, scratch, base);
      versions.push({ label, file, cwd: scratch?.checkout ?? evalCheckout(repoRoot, set.repo, base, join(outDir, 'checkouts', label)) });
    }
    if (new Set(versions.map(version => version.label)).size !== versions.length) throw new Error('two version files share a label');
    // Every version resolves before any run starts, so a bad one refuses the whole batch.
    const resolved = await Promise.all(
      versions.map(async version => ({ resolved: await resolveVersion(version.file, repoRoot, version.cwd, outDir), cwd: version.cwd }))
    );
    const options: BatchOptions = {
      set,
      rows,
      batch,
      base,
      outDir,
      repoRoot,
      versions: resolved,
      live:
        live === undefined
          ? undefined
          : new Map(
              [...live].map(([label, scratch]) => [label, { scratch, copies: readCopies(outDir, label, scratch.repo) }])
            ),
      concurrency: values.concurrency === undefined ? undefined : atLeastOne('concurrency', values.concurrency),
    };
    const { lines, checks } = await runBatch(options);
    for (const line of lines) {
      console.log(`${line.version.label} ${line.row}: ${line.status}${line.passed ? '' : ` (${line.problems.join('; ')})`}`);
    }
    if (!checks.passed) {
      for (const [name, check] of Object.entries(checks.checks)) {
        for (const problem of check.problems) console.error(`hard check ${name} failed: ${problem}`);
      }
      console.error(`batch ${String(batch)} (${checks.batch_run}) FAILED its hard checks; do not evaluate it`);
      process.exitCode = 1;
    }
    return;
  }

  throw new Error('the command must be select, run, copy, score or page');
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
