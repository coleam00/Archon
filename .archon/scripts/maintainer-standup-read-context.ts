#!/usr/bin/env bun
/**
 * Loads local context for the maintainer-standup synthesis: direction.md
 * (committed), profile.md (per-maintainer), prior state.json, and the most
 * recent N briefs.
 *
 * Output: JSON to stdout.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const RECENT_BRIEFS_LIMIT = 3;

const baseDir = resolve(process.cwd(), '.archon/maintainer-standup');

const directionPath = resolve(baseDir, 'direction.md');
const direction = existsSync(directionPath) ? readFileSync(directionPath, 'utf8') : '';

const profilePath = resolve(baseDir, 'profile.md');
const profile = existsSync(profilePath) ? readFileSync(profilePath, 'utf8') : '';

const statePath = resolve(baseDir, 'state.json');
let priorState: unknown = null;
if (existsSync(statePath)) {
  try {
    priorState = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    priorState = null;
  }
}

const briefsDir = resolve(baseDir, 'briefs');
const recentBriefs: { date: string; content: string }[] = [];
if (existsSync(briefsDir)) {
  const files = readdirSync(briefsDir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .reverse()
    .slice(0, RECENT_BRIEFS_LIMIT);
  for (const f of files) {
    recentBriefs.push({
      date: f.replace(/\.md$/, ''),
      content: readFileSync(resolve(briefsDir, f), 'utf8'),
    });
  }
}

console.log(
  JSON.stringify({
    direction,
    profile,
    prior_state: priorState,
    recent_briefs: recentBriefs,
  }),
);
