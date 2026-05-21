/**
 * One-shot patch for foundation.html: removes the top-right "Console →" pill
 * from the bundled JSX module so the standalone brand sheet stops cross-linking
 * to the Console doc.
 *
 * Re-run if you ever re-export the foundation HTML from Penpot.
 */
import { readFileSync, writeFileSync } from 'fs';
import { gunzipSync, gzipSync } from 'zlib';

const TARGET_UUID = '0779aa1d-eb15-4e5c-8f25-e0ee165f5cbb';
const HEADER_BLOCK_START = '        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>';
const HEADER_BLOCK_END = '          </a>\n        </div>';

const path = process.argv[2];
if (!path) {
  console.error('usage: bun _patch.ts <foundation.html>');
  process.exit(1);
}

const file = readFileSync(path, 'utf8');
const lines = file.split('\n');
const manifestLineIdx = lines.findIndex((l, i) => i >= 180 && l.startsWith('{"'));
if (manifestLineIdx < 0) throw new Error('manifest line not found');
const manifest = JSON.parse(lines[manifestLineIdx]) as Record<
  string,
  { mime: string; compressed: boolean; data: string }
>;

const entry = manifest[TARGET_UUID];
if (!entry) throw new Error(`uuid ${TARGET_UUID} not in manifest`);

const raw = Buffer.from(entry.data, 'base64');
const original = entry.compressed ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');

const startIdx = original.indexOf(HEADER_BLOCK_START);
if (startIdx < 0) throw new Error('header block start not found — already patched?');
const endIdx = original.indexOf(HEADER_BLOCK_END, startIdx);
if (endIdx < 0) throw new Error('header block end not found');

const patched =
  original.slice(0, startIdx) +
  original.slice(endIdx + HEADER_BLOCK_END.length).replace(/^\n/, '');

const verify = patched.match(/Console →/g) ?? [];
console.log(`Console → occurrences: ${verify.length} (was 2, should be 1 after patch)`);

const reEncoded = entry.compressed
  ? gzipSync(Buffer.from(patched, 'utf8')).toString('base64')
  : Buffer.from(patched, 'utf8').toString('base64');

manifest[TARGET_UUID] = { ...entry, data: reEncoded };
lines[manifestLineIdx] = JSON.stringify(manifest);

writeFileSync(path, lines.join('\n'));
console.log(`patched ${path} (entry shrank from ${original.length} to ${patched.length} chars)`);
