#!/usr/bin/env bun
/**
 * Stages a standing-eval-suite run: validates the dataset exists and writes the
 * list of case file paths to $ARTIFACTS_DIR/eval/queue.txt for the judge node.
 *
 * Named script (NOT inline): inline multi-line `script:` nodes are passed to
 * `bun -e` as a single argv string, which truncates at the first newline on
 * Windows — so anything non-trivial MUST be a named script run via `bun run`.
 *
 * Reads: process.cwd() (= the run's working_path), EVAL_SUITE (default "seed"),
 *        ARTIFACTS_DIR (injected by the executor). Pure Node fs — bun cannot
 *        resolve `yaml` from the checkout root, so anything bun touches is JSON;
 *        the YAML case files are read by the AI judge natively.
 * Output: JSON summary to stdout (captured as $load-suite.output).
 */
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const suite = process.env.EVAL_SUITE || 'seed';
const dir = join(process.cwd(), '.archon', 'evals', suite);
const casesDir = join(dir, 'cases');
const manifestPath = join(dir, 'suite.json');

if (!existsSync(manifestPath)) {
  console.error(`Eval suite manifest not found: ${manifestPath}`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const caseFiles = existsSync(casesDir)
  ? readdirSync(casesDir)
      .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
      .sort()
  : [];
if (caseFiles.length === 0) {
  console.error(`No case files found in ${casesDir}`);
  process.exit(1);
}

const art = process.env.ARTIFACTS_DIR;
if (!art) {
  console.error('ARTIFACTS_DIR not set; cannot stage eval run');
  process.exit(1);
}
const evalDir = join(art, 'eval');
mkdirSync(evalDir, { recursive: true });

const queue = caseFiles.map((f) => join(casesDir, f));
writeFileSync(join(evalDir, 'queue.txt'), queue.join('\n') + '\n');

console.log(
  JSON.stringify(
    {
      suite,
      caseCount: caseFiles.length,
      dimensions: manifest.dimensions,
      resultsPath: join(evalDir, 'results.json'),
      cases: caseFiles,
    },
    null,
    2
  )
);
