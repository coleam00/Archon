import { readFileSync } from 'fs';
import { gunzipSync } from 'zlib';

const file = readFileSync(process.argv[2] ?? './foundation.html', 'utf8');
const lines = file.split('\n');
const manifestLine = lines.find((l, i) => i >= 180 && l.startsWith('{"'));
if (!manifestLine) {
  console.error('manifest line not found');
  process.exit(1);
}
const manifest = JSON.parse(manifestLine) as Record<
  string,
  { mime: string; compressed: boolean; data: string }
>;

for (const [uuid, entry] of Object.entries(manifest)) {
  if (!entry.mime.includes('javascript') && !entry.mime.includes('jsx')) continue;
  const raw = Buffer.from(entry.data, 'base64');
  const text = entry.compressed
    ? gunzipSync(raw).toString('utf8')
    : raw.toString('utf8');
  const matches = [...text.matchAll(/.{0,40}[Cc]onsole.{0,40}/g)];
  if (matches.length > 0) {
    console.log(`\n=== ${uuid} (${entry.mime}, ${text.length} chars, compressed=${entry.compressed}) ===`);
    for (const m of matches.slice(0, 8)) {
      console.log(`  ${m[0].replace(/\s+/g, ' ')}`);
    }
    if (matches.length > 8) console.log(`  ... +${matches.length - 8} more`);
  }
}
