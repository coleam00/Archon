#!/usr/bin/env bun
/**
 * Marketplace lint — validates marketplace.ts entries.
 * Run: bun packages/docs-web/scripts/lint-marketplace.ts
 * Exit 0 = pass, exit 1 = validation failures found.
 */
import { marketplaceEntries, VALID_HOSTS } from '../src/data/marketplace';

let errors = 0;

function fail(msg: string): void {
  console.error(`  ✗ ${msg}`);
  errors++;
}

console.log(`Linting ${String(marketplaceEntries.length)} marketplace entries...\n`);

// 1. Duplicate slug check
const slugsSeen = new Set<string>();
for (const entry of marketplaceEntries) {
  if (slugsSeen.has(entry.slug)) {
    fail(`Duplicate slug: '${entry.slug}'`);
  }
  slugsSeen.add(entry.slug);
}

// 2. Required fields + host allowlist
for (const entry of marketplaceEntries) {
  const prefix = `[${entry.slug}]`;

  if (!entry.slug || !/^[a-z0-9-]+$/.test(entry.slug)) {
    fail(`${prefix} slug must be lowercase alphanumeric with hyphens only`);
  }
  if (!entry.name?.trim()) fail(`${prefix} name is required`);
  if (!entry.author?.trim()) fail(`${prefix} author is required`);
  if (!entry.description?.trim()) fail(`${prefix} description is required`);
  if (!entry.sha || !/^[0-9a-f]{40}$/.test(entry.sha)) {
    fail(`${prefix} sha must be a full 40-char hex SHA`);
  }
  if (!entry.archonVersionCompat?.trim()) fail(`${prefix} archonVersionCompat is required`);
  if (!entry.tags?.length) fail(`${prefix} must have at least one tag`);

  // Host allowlist
  const allowed = VALID_HOSTS.some((h) => entry.sourceUrl.startsWith(`https://${h}/`));
  if (!allowed) {
    fail(
      `${prefix} sourceUrl must start with https://github.com/ (allowed hosts: ${VALID_HOSTS.join(', ')})`,
    );
  }
}

// 3. SHA + source existence (network checks — supports both file and directory URLs)
console.log('Verifying sources exist at pinned SHAs...');
const checks = marketplaceEntries.map(async (entry) => {
  const isDir = entry.sourceUrl.includes('/tree/');

  if (isDir) {
    // Directory: validate via GitHub Contents API
    const match = entry.sourceUrl.match(
      /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/[^/]+\/(.+)$/,
    );
    if (!match) {
      fail(`[${entry.slug}] Cannot parse directory URL: ${entry.sourceUrl}`);
      return;
    }
    const [, owner, repo, path] = match;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${entry.sha}`;
    try {
      const res = await fetch(apiUrl, {
        method: 'GET',
        headers: { Accept: 'application/vnd.github.v3+json' },
      });
      if (!res.ok) {
        fail(
          `[${entry.slug}] Directory not found at pinned SHA: ${apiUrl} (HTTP ${String(res.status)})`,
        );
      } else {
        console.log(`  ✓ [${entry.slug}] directory verified at ${entry.sha.slice(0, 8)}`);
      }
    } catch (error) {
      const err = error as Error;
      fail(`[${entry.slug}] Failed to reach GitHub API: ${err.message}`);
    }
  } else {
    // Single file: validate via raw URL
    const rawUrl = entry.sourceUrl
      .replace('https://github.com/', 'https://raw.githubusercontent.com/')
      .replace(/\/blob\/[^/]+\//, `/${entry.sha}/`);
    try {
      const res = await fetch(rawUrl, { method: 'HEAD' });
      if (!res.ok) {
        fail(
          `[${entry.slug}] Source file not found at pinned SHA: ${rawUrl} (HTTP ${String(res.status)})`,
        );
      } else {
        console.log(`  ✓ [${entry.slug}] ${rawUrl}`);
      }
    } catch (error) {
      const err = error as Error;
      fail(`[${entry.slug}] Failed to reach source: ${err.message}`);
    }
  }
});

await Promise.all(checks);

console.log('');
if (errors > 0) {
  console.error(`Marketplace lint FAILED — ${String(errors)} error(s) found.`);
  process.exit(1);
} else {
  console.log(
    `Marketplace lint PASSED — all ${String(marketplaceEntries.length)} entries valid.`,
  );
}
