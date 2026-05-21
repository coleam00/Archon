import { readFileSync, writeFileSync } from 'fs';
import { gunzipSync } from 'zlib';

const file = readFileSync(process.argv[2], 'utf8');
const uuid = process.argv[3];
const outFile = process.argv[4];

const lines = file.split('\n');
const manifestLine = lines.find((l, i) => i >= 180 && l.startsWith('{"'));
if (!manifestLine) throw new Error('manifest not found');
const manifest = JSON.parse(manifestLine);
const entry = manifest[uuid];
if (!entry) throw new Error('uuid not in manifest');
const raw = Buffer.from(entry.data, 'base64');
const text = entry.compressed ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
writeFileSync(outFile, text);
console.log(`wrote ${text.length} chars to ${outFile} (mime=${entry.mime}, compressed=${entry.compressed})`);
