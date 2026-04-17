#!/usr/bin/env bun
/**
 * Poll a GitHub PR's comments for a review-app URL matching a regex.
 *
 * Usage:
 *   bun .archon/scripts/fetch-review-app-url.js <pr> <regex> [timeout-ms] [interval-ms]
 *
 * Exit codes:
 *   0 — URL found; printed to stdout as the only stdout line
 *   3 — timeout reached without a match
 *   2 — bad args / gh failure / invalid regex / bad comments JSON
 *
 * The workflow consumes the trimmed stdout via $<node-id>.output.
 * All log lines go to stderr so the URL is the only stdout content.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 20 * 1000;

async function pollOnce(pr, regex) {
  const { stdout } = await execFileAsync('gh', [
    'pr',
    'view',
    pr,
    '--json',
    'comments',
  ]);
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`gh returned non-JSON stdout: ${stdout.slice(0, 200)}`);
  }
  const comments = parsed.comments ?? [];
  for (const c of comments) {
    const match = typeof c.body === 'string' ? c.body.match(regex) : null;
    if (match) return match[0];
  }
  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const [pr, regexStr, timeoutArg, intervalArg] = process.argv.slice(2);

  if (!pr || !regexStr) {
    console.error(
      'Usage: fetch-review-app-url.js <pr> <regex> [timeout-ms] [interval-ms]'
    );
    process.exit(2);
  }

  let regex;
  try {
    regex = new RegExp(regexStr);
  } catch (err) {
    console.error(
      `Invalid regex ${JSON.stringify(regexStr)}: ${err.message}`
    );
    process.exit(2);
  }

  const timeoutMs = timeoutArg ? Number(timeoutArg) : DEFAULT_TIMEOUT_MS;
  const intervalMs = intervalArg ? Number(intervalArg) : DEFAULT_INTERVAL_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    console.error(`Invalid timeout-ms: ${timeoutArg}`);
    process.exit(2);
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    console.error(`Invalid interval-ms: ${intervalArg}`);
    process.exit(2);
  }

  const deadline = Date.now() + timeoutMs;
  console.error(
    `Polling PR ${pr} for pattern ${regex} every ${Math.round(intervalMs / 1000)}s, up to ${Math.round(timeoutMs / 1000)}s total...`
  );

  while (Date.now() < deadline) {
    try {
      const match = await pollOnce(pr, regex);
      if (match) {
        console.log(match);
        return;
      }
    } catch (err) {
      console.error(`Poll error (will retry): ${err.message}`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }

  console.error(
    `No matching comment found on PR ${pr} within ${Math.round(timeoutMs / 1000)}s.`
  );
  process.exit(3);
}

void main();
