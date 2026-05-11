#!/usr/bin/env bun
/**
 * Downloads marketplace entry source files at pinned SHA to $ARTIFACTS_DIR/source/.
 * Walks subdirectories recursively via GitHub Contents API.
 * Output: JSON to stdout: { files: string[], errors: string[] }
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';

const artifactsDir = process.env['ARTIFACTS_DIR'] ?? '';
if (!artifactsDir) {
  process.stderr.write('ARTIFACTS_DIR env var is required\n');
  process.exit(1);
}

const entryPath = resolve(artifactsDir, 'entry.json');
if (!existsSync(entryPath)) {
  process.stderr.write(`entry.json not found at ${entryPath}\n`);
  process.exit(1);
}

interface MarketplaceEntry {
  sourceUrl: string;
  sha: string;
}

const entry = JSON.parse(readFileSync(entryPath, 'utf8')) as MarketplaceEntry;
const { sourceUrl, sha } = entry;

const sourceDir = resolve(artifactsDir, 'source');
mkdirSync(sourceDir, { recursive: true });

const errors: string[] = [];
const files: string[] = [];

// Parse GitHub blob/tree URL into owner/repo/path
const blobMatch = sourceUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/[^/]+\/(.+)$/);
const treeMatch = sourceUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/[^/]+\/(.+)$/);

function ghApi(path: string): string {
  try {
    return execFileSync('gh', ['api', path], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (e) {
    const msg = `gh api ${path} failed: ${(e as Error).message}`;
    process.stderr.write(msg + '\n');
    errors.push(msg);
    return '';
  }
}

function saveFile(relativePath: string, content: string): void {
  const dest = resolve(sourceDir, relativePath);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, content);
  files.push(relativePath);
}

function fetchContents(owner: string, repo: string, dirPath: string, relativePrefix: string): void {
  const apiPath = `/repos/${owner}/${repo}/contents/${dirPath}?ref=${sha}`;
  const raw = ghApi(apiPath);
  if (!raw) return;

  const entries = JSON.parse(raw) as Array<{ type: string; name: string; path: string }>;
  for (const item of entries) {
    const relativePath = relativePrefix ? `${relativePrefix}/${item.name}` : item.name;
    if (item.type === 'dir') {
      fetchContents(owner, repo, item.path, relativePath);
    } else if (item.type === 'file') {
      const filePath = `/repos/${owner}/${repo}/contents/${item.path}?ref=${sha}`;
      const fileRaw = ghApi(filePath);
      if (fileRaw) {
        const fileData = JSON.parse(fileRaw) as { content?: string };
        if (fileData.content) {
          const decoded = Buffer.from(fileData.content.replace(/\n/g, ''), 'base64').toString('utf8');
          saveFile(relativePath, decoded);
        }
      }
    }
  }
}

if (blobMatch) {
  const [, owner, repo, path] = blobMatch;
  const apiPath = `/repos/${owner}/${repo}/contents/${path}?ref=${sha}`;
  const raw = ghApi(apiPath);
  if (raw) {
    const data = JSON.parse(raw) as { content?: string; name?: string };
    if (data.content) {
      const decoded = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
      saveFile(data.name ?? basename(path), decoded);
    }
  }
} else if (treeMatch) {
  const [, owner, repo, path] = treeMatch;
  fetchContents(owner, repo, path, '');
} else {
  const msg = `Unrecognized sourceUrl format: ${sourceUrl}`;
  process.stderr.write(msg + '\n');
  errors.push(msg);
  process.exit(1);
}

console.log(JSON.stringify({ files, errors }));
