/**
 * Where a child-spawn source capture spends its time, and which write primitive it pays for.
 *
 * Every `workflow:` child freezes its own source (#2924), and the write half of that freeze
 * is untouched: `captureWorkflowSource` copies every mutable source file and writes every
 * bundled file into each capture. On Windows, file creation is what Defender interposes on,
 * so writes are the suspected cost — but every number the project holds was measured on
 * macOS, which does not exhibit the problem. Hard-linking, the obvious way to stop paying
 * per-file write cost, measured 3x WORSE than copying on APFS; a hard link is a directory
 * entry with no new content, which is plausibly the one thing Defender does not scan. The
 * lever that looks worst here may be the best one there.
 *
 * So this harness measures rather than fixes. It answers four questions:
 *
 *   1. What fraction of a capture is copying versus digesting versus everything else?
 *      Measured on the REAL `captureWorkflowSource`, through the phase hook it now accepts.
 *   2. Does per-file cost scale with file COUNT or with total BYTES? Interposition predicts
 *      count; ordinary I/O predicts bytes. Measured by holding total bytes fixed and moving
 *      the file count.
 *   3. Does a hard link avoid the per-file cost a copy pays? Measured as `copyFile` versus
 *      `link` versus `writeFile` over one identical tree.
 *   4. How much does a neighbouring workload change all of the above? Measured by repeating
 *      everything with N background workers churning files.
 *
 * Questions 2-4 cannot run on the real capture: they need trees this harness controls. Those
 * sections are explicitly synthetic and say so in their output. Section 1 is not — it calls
 * `captureWorkflowSource` with the options `prepareWorkflowSource` builds for a child spawn
 * (`packages/workflows/src/executor.ts`), against this checkout.
 *
 * Usage:
 *
 *   bun run bench:capture                  # everything, idle then under load
 *   bun run bench:capture -- --help        # options
 *
 * `ARCHON_HOME` is pinned to a scratch directory for the duration, so the global source
 * scope is empty and two machines measure the same tree. Nothing is written outside the OS
 * temp directory, and the repository is only ever read.
 */
import { mkdir, mkdtemp, writeFile, copyFile, link, readFile, readdir, rm } from 'node:fs/promises';
import { cpus, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { setLogLevel } from '@archon/paths';
import { loadConfig } from '../packages/core/src/config/config-loader';
import {
  captureWorkflowSource,
  createCaptureProfiler,
  workflowSourceConfigFrom,
  CAPTURE_PHASES,
  type CapturePhase,
  type CapturePhaseTotals,
} from '../packages/workflows/src/workflow-source';

const REPO_ROOT = resolve(import.meta.dir, '..');

/** Attempts before a scratch tree that will not come free is reported rather than retried. */
const CLEANUP_ATTEMPTS = 10;
const CLEANUP_DELAY_MS = 50;

interface Options {
  /** Captures and repetitions per measurement. */
  runs: number;
  /** Background worker processes for the loaded pass. Zero skips that pass. */
  load: number;
  /** Files in the synthetic tree the write-primitive sections use. */
  files: number;
  /** Bytes per file in that tree. */
  bytes: number;
  json: boolean;
}

const DEFAULTS: Options = { runs: 7, load: 4, files: 200, bytes: 8192, json: false };

const USAGE = `Measure what a child-spawn source capture costs, and which write primitive it pays for.

  bun run bench:capture [-- options]

Options:
  --runs N     captures and repetitions per measurement (default ${DEFAULTS.runs})
  --load N     background worker processes for the loaded pass, 0 to skip (default ${DEFAULTS.load})
  --files N    files in the synthetic write-primitive tree (default ${DEFAULTS.files})
  --bytes N    bytes per file in that tree (default ${DEFAULTS.bytes})
  --json       also print the whole result as one JSON object
  --help       this text

Report the full output. On Windows, run it with real-time protection on — that is the
condition under measurement — and say in the report whether the repository sits on an
excluded path.`;

function parseOptions(argv: readonly string[]): Options | 'help' {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') return 'help';
    if (flag === '--json') {
      options.json = true;
      continue;
    }
    const key = flag.startsWith('--') ? flag.slice(2) : '';
    if (key !== 'runs' && key !== 'load' && key !== 'files' && key !== 'bytes') {
      throw new Error(`Unknown option ${flag}. Run with --help.`);
    }
    const raw = argv[++i];
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${flag} needs a non-negative integer, got ${raw}.`);
    }
    if (value === 0 && key !== 'load') throw new Error(`${flag} must be at least 1.`);
    options[key] = value;
  }
  return options;
}

/** Remove a scratch tree, retrying while the OS still holds a handle inside it. */
async function removeScratchTree(path: string): Promise<void> {
  // Written out rather than delegated to `rm`'s own `maxRetries`, which Bun accepts and
  // ignores, and duplicated from `@archon/paths/test-utils` rather than imported because
  // that module pulls in `bun:test`. See its comment for the measurement.
  for (let attempt = 1; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= CLEANUP_ATTEMPTS) {
        console.warn(`scratch cleanup failed for ${path}: ${String(error)}`);
        return;
      }
      await Bun.sleep(CLEANUP_DELAY_MS);
    }
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

const ms = (value: number): string => value.toFixed(2);

// ---------------------------------------------------------------------------
// Background load
// ---------------------------------------------------------------------------

/**
 * One background worker: churn small files forever, in its own directory.
 *
 * File churn rather than pure CPU because contention on macOS moved an identical capture
 * from 33.6 ms to 395.2 ms with byte-identical operation counts, and the suspected Windows
 * cost is in the filesystem path too. Workers run as separate processes because the load
 * that produces the flake class is `bun --filter --parallel`, which is processes (#2306).
 */
async function runLoadWorker(dir: string): Promise<never> {
  await mkdir(dir, { recursive: true });
  const payload = Buffer.alloc(16 * 1024, 7);
  for (let round = 0; ; round++) {
    const roundDir = join(dir, `r${String(round % 4)}`);
    await mkdir(roundDir, { recursive: true });
    for (let i = 0; i < 32; i++) await writeFile(join(roundDir, `f${String(i)}`), payload);
    for (const entry of await readdir(roundDir)) await readFile(join(roundDir, entry));
    await rm(roundDir, { recursive: true, force: true });
  }
}

interface LoadHandle {
  /**
   * Kill every worker and wait for it to be gone.
   *
   * Awaited rather than fire-and-forget because the scratch tree is removed next, and a
   * worker still writing inside it makes that removal fail — on Windows, the platform this
   * tool exists for, with a lock error rather than a clean one.
   */
  stop: () => Promise<void>;
}

async function startLoad(count: number, dir: string): Promise<LoadHandle> {
  const children = Array.from({ length: count }, (_unused, i) =>
    Bun.spawn([process.execPath, import.meta.path, '--load-worker', join(dir, `w${String(i)}`)], {
      stdout: 'ignore',
      // Inherited, not dropped: a worker that dies says why, and the next block turns its
      // silence into a failure rather than into a quietly lighter measurement.
      stderr: 'inherit',
    })
  );
  const stop = async (): Promise<void> => {
    for (const child of children) child.kill();
    await Promise.all(children.map(child => child.exited));
  };

  // Let the workers reach steady state before anything is timed against them.
  await Bun.sleep(500);
  const exited = children.filter(child => child.exitCode !== null).length;
  if (exited > 0) {
    await stop();
    throw new Error(
      `${String(exited)} of ${String(count)} load workers exited during startup. The loaded ` +
        'pass would report contention it never ran under, so it is not run at all.'
    );
  }
  return { stop };
}

// ---------------------------------------------------------------------------
// Section 1: the real capture
// ---------------------------------------------------------------------------

interface CaptureSample {
  totalMs: number;
  phases: Record<CapturePhase, CapturePhaseTotals>;
}

interface CaptureResult {
  /** The first capture in the process, which reads the bundled trees rather than revalidating. */
  cold: CaptureSample;
  /** Every capture after it — the shape a run's second and later children pay. */
  warm: CaptureSample[];
  fileCount: number;
  byteCount: number;
  digest: string;
  scopes: string[];
}

async function measureCapture(scratch: string, options: Options): Promise<CaptureResult> {
  const config = workflowSourceConfigFrom(await loadConfig(REPO_ROOT));

  const samples: CaptureSample[] = [];
  let fileCount = 0;
  let byteCount = 0;
  let digest = '';
  let scopes: string[] = [];

  for (let run = 0; run <= options.runs; run++) {
    const captureRoot = join(scratch, 'captures', `run-${String(run)}`);
    const { profiler, totals } = createCaptureProfiler();
    const started = performance.now();
    const capture = await captureWorkflowSource({
      sourceRoot: REPO_ROOT,
      captureRoot,
      commandFolder: config.command_folder,
      sourceConfig: config,
      profiler,
    });
    samples.push({ totalMs: performance.now() - started, phases: totals });
    ({ file_count: fileCount, byte_count: byteCount, digest } = capture.manifest);
    scopes = capture.manifest.scopes;
    await removeScratchTree(captureRoot);
  }

  return { cold: samples[0], warm: samples.slice(1), fileCount, byteCount, digest, scopes };
}

function printCapture(result: CaptureResult): void {
  const warmTotal = median(result.warm.map(s => s.totalMs));
  console.log(
    `capture of ${REPO_ROOT}\n` +
      `  scopes ${result.scopes.join('+')}, ${String(result.fileCount)} files, ` +
      `${String(result.byteCount)} bytes, digest ${result.digest.slice(0, 12)}\n` +
      `  first capture (reads the bundled trees) ${ms(result.cold.totalMs)} ms\n` +
      `  median of ${String(result.warm.length)} later captures ${ms(warmTotal)} ms`
  );
  console.log(
    `  ${'phase'.padEnd(14)}${'median ms'.padStart(10)}${'%'.padStart(7)}` +
      `${'cold ms'.padStart(10)}${'dirs'.padStart(7)}${'files'.padStart(7)}${'bytes'.padStart(11)}`
  );
  for (const phase of CAPTURE_PHASES) {
    const warm = median(result.warm.map(s => s.phases[phase].ms));
    const counts = result.warm[result.warm.length - 1].phases[phase];
    console.log(
      `  ${phase.padEnd(14)}${ms(warm).padStart(10)}` +
        ((warm / warmTotal) * 100).toFixed(1).padStart(7) +
        ms(result.cold.phases[phase].ms).padStart(10) +
        `${String(counts.dirs).padStart(7)}${String(counts.files).padStart(7)}` +
        String(counts.bytes).padStart(11)
    );
  }
  // Whatever the phases do not cover: loop bookkeeping, building the manifest, the call
  // itself. Printed so "everything else" is a measured number rather than a subtraction
  // the reader has to do and cannot check.
  const unphased = (sample: CaptureSample): number =>
    sample.totalMs - CAPTURE_PHASES.reduce((sum, phase) => sum + sample.phases[phase].ms, 0);
  const warmUnphased = median(result.warm.map(unphased));
  console.log(
    `  ${'(unphased)'.padEnd(14)}${ms(warmUnphased).padStart(10)}` +
      ((warmUnphased / warmTotal) * 100).toFixed(1).padStart(7) +
      ms(unphased(result.cold)).padStart(10)
  );
}

// ---------------------------------------------------------------------------
// Sections 2 and 3: write primitives, and what their cost scales with
// ---------------------------------------------------------------------------

const WRITE_MODES = ['copyFile', 'link', 'writeFile'] as const;
type WriteMode = (typeof WRITE_MODES)[number];

interface WriteSample {
  files: number;
  bytes: number;
  /** Median ms for one full pass over the tree, per mode. */
  perMode: Record<WriteMode, number>;
}

/** A flat tree of `files` identical files, plus the buffer `writeFile` writes from. */
async function makeTree(
  root: string,
  files: number,
  bytes: number
): Promise<{ paths: string[]; payload: Buffer }> {
  await mkdir(root, { recursive: true });
  const payload = Buffer.alloc(bytes, 42);
  const paths: string[] = [];
  for (let i = 0; i < files; i++) {
    const path = join(root, `f${String(i)}.txt`);
    await writeFile(path, payload);
    paths.push(path);
  }
  return { paths, payload };
}

async function measureWriteModes(
  scratch: string,
  files: number,
  bytes: number,
  runs: number
): Promise<WriteSample> {
  const source = join(scratch, `src-${String(files)}x${String(bytes)}`);
  const { paths, payload } = await makeTree(source, files, bytes);
  const perMode = {} as Record<WriteMode, number>;

  for (const mode of WRITE_MODES) {
    const timings: number[] = [];
    for (let run = 0; run < runs; run++) {
      const dest = join(scratch, `dest-${mode}-${String(files)}-${String(run)}`);
      await mkdir(dest, { recursive: true });
      const started = performance.now();
      for (let i = 0; i < paths.length; i++) {
        const target = join(dest, `f${String(i)}.txt`);
        if (mode === 'copyFile') await copyFile(paths[i], target);
        else if (mode === 'link') await link(paths[i], target);
        else await writeFile(target, payload);
      }
      timings.push(performance.now() - started);
      await removeScratchTree(dest);
    }
    perMode[mode] = median(timings);
  }

  await removeScratchTree(source);
  return { files, bytes, perMode };
}

/** File counts to sweep at a fixed total size, centred on the configured tree. */
function scalingPoints(files: number, bytes: number): { files: number; bytes: number }[] {
  const total = files * bytes;
  return [4, 2, 1, 0.5, 0.25]
    .map(factor => Math.round(files * factor))
    .filter(count => count >= 1 && total % count === 0)
    .map(count => ({ files: count, bytes: total / count }));
}

function printWriteModes(samples: readonly WriteSample[]): void {
  const total = samples[0].files * samples[0].bytes;
  console.log(
    `write primitives, synthetic flat tree, ${String(total)} bytes total in every row\n` +
      '  a per-file cost shows as ms rising with the file count; a per-byte cost stays flat'
  );
  console.log(
    `  ${'files'.padStart(7)}${'bytes/file'.padStart(12)}` +
      WRITE_MODES.map(m => `${m} ms`.padStart(16)).join('') +
      'us/file copy'.padStart(14)
  );
  for (const sample of samples) {
    console.log(
      `  ${String(sample.files).padStart(7)}${String(sample.bytes).padStart(12)}` +
        WRITE_MODES.map(m => ms(sample.perMode[m]).padStart(16)).join('') +
        ((sample.perMode.copyFile / sample.files) * 1000).toFixed(1).padStart(14)
    );
  }
}

// ---------------------------------------------------------------------------
// Passes
// ---------------------------------------------------------------------------

interface Pass {
  label: string;
  capture: CaptureResult;
  writes: WriteSample[];
}

async function runPass(label: string, scratch: string, options: Options): Promise<Pass> {
  const capture = await measureCapture(scratch, options);
  const writes: WriteSample[] = [];
  for (const point of scalingPoints(options.files, options.bytes)) {
    writes.push(await measureWriteModes(scratch, point.files, point.bytes, options.runs));
  }
  return { label, capture, writes };
}

function printPass(pass: Pass): void {
  console.log(`\n=== ${pass.label} ===\n`);
  printCapture(pass.capture);
  console.log('');
  printWriteModes(pass.writes);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === '--load-worker') {
    const dir = argv[1];
    if (dir === undefined) throw new Error('--load-worker needs a directory.');
    await runLoadWorker(dir);
  }

  let options: Options | 'help';
  try {
    options = parseOptions(argv);
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
  if (options === 'help') {
    console.log(USAGE);
    return 0;
  }

  const scratch = await mkdtemp(join(tmpdir(), 'archon-capture-cost-'));
  // Pin the global source scope to an empty directory so the capture under measurement is
  // this checkout's project and bundled scopes, and nothing a particular machine happens to
  // keep in its real Archon home.
  process.env.ARCHON_HOME = join(scratch, 'home');
  // Keep the report readable while leaving real warnings — an oversized capture is one —
  // visible. Set here rather than through LOG_LEVEL because the root logger is built when
  // this file's imports are evaluated, long before main runs; an explicit LOG_LEVEL wins.
  if (process.env.LOG_LEVEL === undefined) setLogLevel('warn');

  console.log(
    'archon capture cost\n' +
      `  ${process.platform}/${process.arch}, ${String(cpus().length)} cpus, ` +
      `${String(Math.round(totalmem() / 2 ** 30))} GiB, bun ${Bun.version}\n` +
      `  repo ${REPO_ROOT}\n` +
      `  scratch ${scratch} (ARCHON_HOME pinned there; global scope empty)\n` +
      `  runs ${String(options.runs)}, load workers ${String(options.load)}`
  );

  const passes: Pass[] = [];
  try {
    passes.push(await runPass('idle', scratch, options));
    if (options.load > 0) {
      const loadDir = join(scratch, 'load');
      const load = await startLoad(options.load, loadDir);
      try {
        passes.push(
          await runPass(`under load (${String(options.load)} workers)`, scratch, options)
        );
      } finally {
        await load.stop();
      }
    }
    for (const pass of passes) printPass(pass);
    if (options.json) {
      console.log(`\n${JSON.stringify({ platform: process.platform, options, passes }, null, 2)}`);
    }
  } finally {
    await removeScratchTree(scratch);
  }
  return 0;
}

process.exit(await main());
