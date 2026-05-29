#!/usr/bin/env bun
/**
 * Reads raw synthesize-node output on stdin and writes the brief markdown +
 * state.json to .archon/maintainer-standup/. Handles two formats:
 *
 *   Preferred — delimited markers:
 *     # Maintainer Standup — YYYY-MM-DD
 *     ...brief...
 *     ARCHON_STATE_JSON_BEGIN
 *     {...state json...}
 *     ARCHON_STATE_JSON_END
 *
 *   Fallback — JSON-wrapped (what Pi/Minimax tends to emit):
 *     [optional prose preamble]
 *     {"brief_markdown": "...", "next_state": {...}}
 *
 * The fallback path is here because Pi/Minimax M2.7 ignores the delimiter
 * directive and emits the JSON-wrapper format consistently. JSON.parse can
 * still recover it provided the model escaped newlines/quotes correctly.
 *
 * Output: one line of JSON to stdout: {"date","state_path","brief_path"}.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const raw = await Bun.stdin.text();

type State = Record<string, unknown>;
let brief: string | null = null;
let state: State | null = null;
let source: 'delimiter' | 'json-wrapper' | null = null;

// ── Tier 1: delimiter-based extraction ──
// Line-anchored (^...$, gm) to prevent false matches when marker text appears in prose.
const BEGIN_RE = /^ARCHON_STATE_JSON_BEGIN$/gm;
const END_RE = /^ARCHON_STATE_JSON_END$/gm;

const beginMatches = [...raw.matchAll(BEGIN_RE)];
const endMatches = [...raw.matchAll(END_RE)];

if (beginMatches.length > 0 && endMatches.length > 0) {
  // Strategy: last END, then last BEGIN before it — the complete final block.
  const lastEnd = endMatches[endMatches.length - 1];
  const lastEndIdx = lastEnd.index!;

  const beginsBeforeEnd = beginMatches.filter((m) => m.index! < lastEndIdx);
  if (beginsBeforeEnd.length > 0) {
    const lastBegin = beginsBeforeEnd[beginsBeforeEnd.length - 1];
    const afterBeginIdx = lastBegin.index! + lastBegin[0].length;

    const stateText = raw.slice(afterBeginIdx, lastEndIdx).trim();
    try {
      state = JSON.parse(stateText) as State;
      // Brief = everything before the first BEGIN; preserves prose intact even if state was emitted multiple times.
      brief = raw.slice(0, beginMatches[0].index!).trim();
      source = 'delimiter';
      if (beginMatches.length > 1) {
        process.stderr.write(
          `WARN: ${beginMatches.length} ARCHON_STATE_JSON_BEGIN markers found; used the last complete pair.\n`,
        );
      }
    } catch (err) {
      const preview = stateText.length > 200 ? stateText.slice(0, 200) + '…' : stateText;
      process.stderr.write(
        `Delimiter found but state JSON parse failed: ${(err as Error).message}\nFailed candidate (first 200 chars): ${preview}\n`,
      );
    }
  } else {
    process.stderr.write(
      `WARN: ARCHON_STATE_JSON_BEGIN/END markers found but all BEGIN markers appear after the last END; skipping delimiter extraction.\n`,
    );
  }
}

// ── Tier 2: JSON-wrapper fallback ({brief_markdown, next_state}) ──
if (state === null) {
  const firstBrace = raw.indexOf('{');
  if (firstBrace !== -1) {
    const candidate = raw.slice(firstBrace);
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (
        typeof parsed.brief_markdown === 'string' &&
        typeof parsed.next_state === 'object' &&
        parsed.next_state !== null
      ) {
        brief = parsed.brief_markdown;
        state = parsed.next_state as State;
        source = 'json-wrapper';
        process.stderr.write(
          'Synth output used JSON-wrapper format (delimiter contract not followed); recovered via fallback.\n',
        );
      }
    } catch (err) {
      process.stderr.write(
        `JSON-wrapper fallback parse failed: ${(err as Error).message}\n`,
      );
    }
  }
}

if (state === null || brief === null) {
  process.stderr.write(
    'PERSIST FAILED: could not extract brief and state from synth output (neither delimiter nor JSON-wrapper format matched).\n',
  );
  process.stderr.write('--- BEGIN raw output (recoverable from logs) ---\n');
  process.stderr.write(raw + '\n');
  process.stderr.write('--- END raw output ---\n');
  process.exit(1);
}

// Strip leading prose preamble — keep from the first '# ' heading onward.
const lines = brief.split('\n');
const headingIdx = lines.findIndex((l) => l.startsWith('# '));
if (headingIdx > 0) {
  brief = lines.slice(headingIdx).join('\n');
}
brief = brief.trim();

const date = new Date().toLocaleDateString('sv-SE'); // local YYYY-MM-DD
const baseDir = resolve(process.cwd(), '.archon/maintainer-standup');
const briefsDir = resolve(baseDir, 'briefs');
const statePath = resolve(baseDir, 'state.json');
const briefPath = resolve(briefsDir, `${date}.md`);

try {
  mkdirSync(briefsDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  writeFileSync(briefPath, brief + '\n');
} catch (err) {
  process.stderr.write(
    `PERSIST FAILED: could not write output files: ${(err as Error).message}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  JSON.stringify({
    date,
    source,
    state_path: '.archon/maintainer-standup/state.json',
    brief_path: `.archon/maintainer-standup/briefs/${date}.md`,
  }) + '\n',
);
