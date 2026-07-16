#!/usr/bin/env bun
/**
 * Write-side plumbing for repo-triage: reads an AI node's raw stdout, extracts
 * the state JSON it emitted, and writes it ATOMICALLY (temp file + rename) to a
 * named state file under `.archon/state/`. Replaces the old "AI uses the Write
 * tool on .archon/state/*.json" step — a rename is atomic, so a crashed run can
 * never leave a half-written state file (hardens the read-modify-write race the
 * maintainer-workflows review flagged as R1's class).
 *
 * Usage:
 *   <ai-node-output> | bun .archon/scripts/repo-triage-persist.ts --target .archon/state/triage-state.json
 *
 * State extraction handles two formats (same contract as maintainer-standup-persist):
 *
 *   Preferred — delimited markers (one line each, anchored):
 *     ARCHON_STATE_JSON_BEGIN
 *     {...state json...}
 *     ARCHON_STATE_JSON_END
 *
 *   Fallback — a bare JSON object (what Pi/Minimax tends to emit when it ignores
 *   the delimiter directive): the largest brace-balanced object in the output.
 *
 * `--target` MUST resolve under `<cwd>/.archon/state/` — a prompt can't redirect
 * this to write arbitrary files. Exits non-zero (leaving prior state intact) on
 * any extraction/parse/write failure, and echoes the raw output to stderr so the
 * state is recoverable from run logs.
 *
 * Output: one line of JSON to stdout: {"target","source","bytes"}.
 */
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

// ── Parse --target ──
const argv = process.argv.slice(2);
let target = '';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--target') {
    target = argv[i + 1] ?? '';
    i++;
  } else if (argv[i].startsWith('--target=')) {
    target = argv[i].slice('--target='.length);
  }
}
if (!target) {
  process.stderr.write('PERSIST FAILED: --target <path> is required.\n');
  process.exit(1);
}

// ── Safety: target must live under <cwd>/.archon/state/ ──
const stateDir = resolve(process.cwd(), '.archon/state');
const targetPath = resolve(process.cwd(), target);
if (targetPath !== stateDir && !targetPath.startsWith(stateDir + '/')) {
  process.stderr.write(
    `PERSIST FAILED: --target must resolve under .archon/state/ (got: ${targetPath}).\n`,
  );
  process.exit(1);
}

const raw = await Bun.stdin.text();

type State = Record<string, unknown>;
let state: State | null = null;
let source: 'delimiter' | 'bare-json' | null = null;

// ── Tier 1: delimiter-based extraction (line-anchored to avoid prose false-matches) ──
const BEGIN_RE = /^ARCHON_STATE_JSON_BEGIN$/gm;
const END_RE = /^ARCHON_STATE_JSON_END$/gm;
const beginMatches = [...raw.matchAll(BEGIN_RE)];
const endMatches = [...raw.matchAll(END_RE)];

if (beginMatches.length > 0 && endMatches.length > 0) {
  // Last END, then the last BEGIN before it — the complete final block, so a
  // truncated earlier block never wins over a well-formed later one.
  const lastEndIdx = endMatches[endMatches.length - 1].index!;
  const beginsBeforeEnd = beginMatches.filter((m) => m.index! < lastEndIdx);
  if (beginsBeforeEnd.length > 0) {
    const lastBegin = beginsBeforeEnd[beginsBeforeEnd.length - 1];
    const stateText = raw.slice(lastBegin.index! + lastBegin[0].length, lastEndIdx).trim();
    try {
      state = JSON.parse(stateText) as State;
      source = 'delimiter';
      if (beginMatches.length > 1) {
        process.stderr.write(
          `WARN: ${beginMatches.length} ARCHON_STATE_JSON_BEGIN markers found; used the last complete pair.\n`,
        );
      }
    } catch (err) {
      const preview = stateText.length > 200 ? stateText.slice(0, 200) + '…' : stateText;
      process.stderr.write(
        `Delimiter found but state JSON parse failed: ${(err as Error).message}\n` +
          `Failed candidate (first 200 chars): ${preview}\n`,
      );
    }
  } else {
    process.stderr.write(
      'WARN: BEGIN/END markers found but every BEGIN follows the last END; skipping delimiter extraction.\n',
    );
  }
}

// ── Tier 2: bare-JSON fallback (largest brace-balanced object) ──
if (state === null) {
  const candidate = extractLargestJsonObject(raw);
  if (candidate !== null) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        state = parsed as State;
        source = 'bare-json';
        process.stderr.write(
          'State output used bare-JSON format (delimiter contract not followed); recovered via fallback.\n',
        );
      }
    } catch (err) {
      process.stderr.write(`bare-JSON fallback parse failed: ${(err as Error).message}\n`);
    }
  }
}

if (state === null) {
  process.stderr.write(
    'PERSIST FAILED: could not extract state JSON (neither delimiter nor bare-JSON matched).\n',
  );
  process.stderr.write('--- BEGIN raw output (recoverable from logs) ---\n');
  process.stderr.write(raw + '\n');
  process.stderr.write('--- END raw output ---\n');
  process.exit(1);
}

// ── Atomic write: temp in the same dir, then rename (atomic on the same filesystem) ──
const serialized = JSON.stringify(state, null, 2) + '\n';
try {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, serialized);
  renameSync(tmp, targetPath);
} catch (err) {
  process.stderr.write(`PERSIST FAILED: could not write ${targetPath}: ${(err as Error).message}\n`);
  process.exit(1);
}

process.stdout.write(
  JSON.stringify({ target, source, bytes: serialized.length }) + '\n',
);

/**
 * Return the substring of the largest brace-balanced `{...}` region in `text`,
 * or null if none. Scans for the first `{`, then walks matching braces while
 * ignoring braces inside JSON string literals (respecting `\` escapes). This is
 * more robust than `slice(indexOf('{'))` when the model appends trailing prose
 * after the JSON.
 */
function extractLargestJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
