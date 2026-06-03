#!/usr/bin/env node
/**
 * Post-build script to normalize Unicode characters in llms*.txt files.
 * This ensures the files render correctly in browsers that don't handle
 * UTF-8 text/plain without explicit charset headers.
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const DIST_DIR = join(import.meta.dirname, '../dist');

// Character replacements: Unicode -> ASCII
const replacements = [
  [/\u2014/g, '--'],   // em-dash -> double hyphen
  [/\u2013/g, '-'],    // en-dash -> hyphen
  [/\u201C/g, '"'],    // left double quote -> straight quote
  [/\u201D/g, '"'],    // right double quote -> straight quote
  [/\u2018/g, "'"],    // left single quote -> apostrophe
  [/\u2019/g, "'"],    // right single quote -> apostrophe
  [/\u2026/g, '...'],  // ellipsis -> three dots
  [/\u00A0/g, ' '],    // non-breaking space -> regular space
  // Emoji to ASCII (browsers without charset=utf-8 render these as mojibake)
  [/\u2705/g, 'Yes'],  // ✅ check mark -> Yes
  [/\u274C/g, 'No'],   // ❌ cross mark -> No
  // Box-drawing characters to ASCII (for directory trees)
  [/\u251C/g, '|'],    // ├ -> |
  [/\u2514/g, '`'],    // └ -> `
  [/\u2500/g, '-'],    // ─ -> -
  [/\u2502/g, '|'],    // │ -> |
  [/\u252C/g, '+'],    // ┬ -> +
  [/\u2534/g, '+'],    // ┴ -> +
  [/\u253C/g, '+'],    // ┼ -> +
  [/\u2510/g, '+'],    // ┐ -> +
  [/\u250C/g, '+'],    // ┌ -> +
  [/\u2518/g, '+'],    // ┘ -> +
  [/\u2524/g, '|'],    // ┤ -> |
  // Arrows and symbols
  [/\u2192/g, '->'],   // → -> ->
  [/\u2190/g, '<-'],   // ← -> <-
  [/\u2191/g, '^'],    // ↑ -> ^
  [/\u2193/g, 'v'],    // ↓ -> v
  [/\u25BC/g, 'v'],    // ▼ -> v (down-pointing triangle)
  [/\u25B2/g, '^'],    // ▲ -> ^ (up-pointing triangle)
  [/\u25B6/g, '>'],    // ▶ -> > (right-pointing triangle)
  [/\u25C0/g, '<'],    // ◀ -> < (left-pointing triangle)
  [/\u2022/g, '*'],    // • -> * (bullet point)
  // Strip [Section titled "..."] artifacts from minified output
  // Match the full pattern including escaped chars in the title and underscores in anchor
  [/ ?\[Section titled ".*?"\]\(#[a-z0-9_-]+\)/g, ''],
];

function normalizeFile(filePath) {
  const original = readFileSync(filePath, 'utf-8');
  let content = original;

  for (const [pattern, replacement] of replacements) {
    content = content.replace(pattern, replacement);
  }

  if (content !== original) {
    writeFileSync(filePath, content, 'utf-8');
    console.log(`Normalized: ${filePath}`);
  }
}

// Find and normalize all llms*.txt files in dist/
const files = readdirSync(DIST_DIR).filter(f => f.startsWith('llms') && f.endsWith('.txt'));

for (const file of files) {
  normalizeFile(join(DIST_DIR, file));
}

// Also process subset files in dist/_llms-txt/
const SUBSETS_DIR = join(DIST_DIR, '_llms-txt');
let subsetFiles = [];
try {
  subsetFiles = readdirSync(SUBSETS_DIR).filter(f => f.endsWith('.txt'));
} catch (err) {
  // Only ENOENT is expected (no customSets configured); rethrow other errors
  if (err.code !== 'ENOENT') throw err;
}

for (const file of subsetFiles) {
  normalizeFile(join(SUBSETS_DIR, file));
}

const totalFiles = files.length + subsetFiles.length;
if (totalFiles === 0) {
  console.warn('Warning: No llms*.txt files found in dist/ — plugin may be disabled or output path changed');
}
console.log(`Processed ${totalFiles} llms.txt file(s)`);
