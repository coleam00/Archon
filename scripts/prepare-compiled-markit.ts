#!/usr/bin/env bun
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const DISABLED_MESSAGE =
  "PDF conversion is disabled in Archon's compiled binary because Bun cannot compile markit-ai's mupdf dependency. Use a source install or Docker for PDF reads.";

const marker = '/* ARCHON_COMPILED_BINARY_PDF_DISABLED */';

async function resolveExtractPath(): Promise<string> {
  const requireFromProviders = createRequire(
    join(process.cwd(), 'packages/providers/package.json')
  );
  const codingAgentPackagePath = requireFromProviders.resolve(
    '@oh-my-pi/pi-coding-agent/package.json'
  );
  const requireFromCodingAgent = createRequire(codingAgentPackagePath);
  const packageJsonPath = requireFromCodingAgent.resolve('markit-ai/package.json');
  return join(dirname(packageJsonPath), 'dist', 'converters', 'pdf', 'extract.js');
}

function patchSource(source: string): string {
  if (source.includes(marker)) return source;

  const renderNeedle = [
    'export function renderImageRegion(input, region) {',
    '    const mupdf = require("mupdf");',
  ].join('\n');
  const renderReplacement = [
    `const ARCHON_COMPILED_BINARY_PDF_DISABLED_MESSAGE = ${JSON.stringify(DISABLED_MESSAGE)};`,
    marker,
    '',
    'export function renderImageRegion(_input, _region) {',
    '    throw new Error(ARCHON_COMPILED_BINARY_PDF_DISABLED_MESSAGE);',
  ].join('\n');

  const extractNeedle = [
    'export async function extractPages(input) {',
    '    let mupdf;',
    '    try {',
    '        mupdf = await import("mupdf");',
    '    }',
    '    catch {',
    '        throw new Error("PDF support requires \'mupdf\'. Install it: npm install mupdf");',
    '    }',
    '    const doc = mupdf.Document.openDocument(input, "application/pdf");',
  ].join('\n');
  const extractReplacement = [
    'export async function extractPages(_input) {',
    '    throw new Error(ARCHON_COMPILED_BINARY_PDF_DISABLED_MESSAGE);',
  ].join('\n');

  if (!source.includes(renderNeedle)) {
    throw new Error(
      'markit-ai PDF render hook changed; cannot patch compiled binary PDF support safely.'
    );
  }
  if (!source.includes(extractNeedle)) {
    throw new Error(
      'markit-ai PDF extract hook changed; cannot patch compiled binary PDF support safely.'
    );
  }

  return source.replace(renderNeedle, renderReplacement).replace(extractNeedle, extractReplacement);
}

async function main(): Promise<void> {
  const extractPath = await resolveExtractPath();
  const backupPath = `${extractPath}.archon-original`;

  if (process.argv.includes('--restore')) {
    if (existsSync(backupPath)) {
      await rename(backupPath, extractPath);
      console.log(`Restored ${extractPath}`);
    }
    return;
  }

  if (!existsSync(backupPath)) {
    await copyFile(extractPath, backupPath);
  }

  const source = await readFile(extractPath, 'utf8');
  await writeFile(extractPath, patchSource(source));
  console.log(`Patched markit-ai PDF converter for compiled binary: ${extractPath}`);
}

await main();
