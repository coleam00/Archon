#!/usr/bin/env bun
/**
 * Extract a single GitHub PR number from a free-form trigger string.
 *
 * Input: process.argv[2] (falls back to $ARGUMENTS env var). The workflow bash
 * node passes "$ARGUMENTS" as a single argv element — it arrives as a subprocess
 * env var, never textually interpolated, so this is injection-safe.
 *
 * Output: the bare number on stdout; also written to $ARTIFACTS_DIR/.pr-number
 * (checked) when ARTIFACTS_DIR is set. Non-zero exit + stderr message on any
 * failure (no number, ambiguous input, or write failure) so the node fails loud.
 *
 * Rules (deterministic — replaces an AI node that did digit-picking):
 *  - ANCHORED forms win: `#N`, `PR N` / `PR#N` / `PR-N` (a separator is REQUIRED
 *    so a URL/repo slug like `pr2-tool` is NOT read as PR #2), and the URL path
 *    segments `pull/N` / `issues/N`.
 *  - MULTIPLE DISTINCT anchored numbers => loud error listing them (the old AI
 *    node errored on ambiguity; a silent first-match would review the wrong PR).
 *  - Bare-number fallback ONLY when the whole trimmed input is a pure number.
 *    Anchor-less input with an incidental digit token (e.g. "coleam00 fix 1428",
 *    "v1.2.3 changelog for 1428") is an ERROR, not a guess.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function collectAnchoredNumbers(input: string): string[] {
  const found = new Set<string>();
  // GitHub URL path segments: .../pull/1428, .../issues/1428
  for (const m of input.matchAll(/\b(?:pull|issues)\/(\d+)/gi)) found.add(m[1]);
  // Hash form: #1428 (digit must immediately follow '#')
  for (const m of input.matchAll(/#(\d+)/g)) found.add(m[1]);
  // "PR" keyword — a separator between "pr" and the digits is REQUIRED, so a
  // word like "pr2-tool" (digit glued to "pr") does not match as PR #2.
  for (const m of input.matchAll(/\bpr[\s#:_-]+(\d+)/gi)) found.add(m[1]);
  return [...found];
}

function extractPrNumber(rawInput: string): string {
  const input = rawInput.trim();
  if (!input) {
    throw new Error('empty input — provide a PR number (#N, PR N, a pull-request URL, or a bare number)');
  }

  const anchored = collectAnchoredNumbers(input);
  if (anchored.length === 1) {
    return anchored[0];
  }
  if (anchored.length > 1) {
    throw new Error(
      `ambiguous input — multiple distinct PR numbers found (${anchored.join(', ')}). ` +
        `Specify exactly one (e.g. "#${anchored[0]}").`,
    );
  }

  // No anchored form. Only accept a bare number when that is the WHOLE input —
  // never pluck a digit token out of prose.
  if (/^\d+$/.test(input)) {
    return input;
  }

  throw new Error(
    `no PR number found in: ${JSON.stringify(input)}. ` +
      `Use "#N", "PR N", a pull-request URL, or pass just the number.`,
  );
}

function main(): void {
  const rawInput = process.argv[2] ?? process.env['ARGUMENTS'] ?? '';

  let prNumber: string;
  try {
    prNumber = extractPrNumber(rawInput);
  } catch (err) {
    process.stderr.write(`ERROR: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const artifactsDir = process.env['ARTIFACTS_DIR'];
  if (artifactsDir) {
    try {
      writeFileSync(resolve(artifactsDir, '.pr-number'), prNumber + '\n');
    } catch (err) {
      process.stderr.write(`ERROR: failed to write .pr-number: ${(err as Error).message}\n`);
      process.exit(1);
    }
  }

  process.stdout.write(prNumber + '\n');
}

main();
