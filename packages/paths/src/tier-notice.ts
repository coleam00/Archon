/**
 * One-time CLI tier-notice state cache.
 *
 * Mirrors the structure of `update-check.ts`, but with NO time-based staleness:
 * the notice re-shows only when the Archon `version` changes (a future version
 * may ship different `tier-defaults.json` values, so a version bump re-alerts).
 *
 * No side effects beyond a single JSON file under `~/.archon`. Read/write errors
 * are swallowed — a missing or corrupt state file simply means "show the notice".
 */
import { join } from 'path';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { getArchonHome } from './archon-paths';
import { createLogger } from './logger';

const log = createLogger('tier-notice');

export interface TierNoticeState {
  shownForVersion: string;
}

const STATE_FILE = 'tier-notice.json';

function getStatePath(): string {
  return join(getArchonHome(), STATE_FILE);
}

/** Read the persisted notice state. Returns null when absent or unreadable (errors silently discarded). */
export function readTierNoticeState(): TierNoticeState | null {
  try {
    const raw = readFileSync(getStatePath(), 'utf-8');
    const data = JSON.parse(raw) as TierNoticeState;
    if (typeof data.shownForVersion !== 'string') return null;
    return data;
  } catch (err) {
    log.debug({ err }, 'tier_notice.read_failed');
    return null;
  }
}

/** Record that the tier notice has been shown for `version`. Errors are logged at debug. */
export function markTierNoticeShown(version: string): void {
  try {
    mkdirSync(getArchonHome(), { recursive: true });
    writeFileSync(getStatePath(), JSON.stringify({ shownForVersion: version }), 'utf-8');
  } catch (err) {
    log.debug({ err }, 'tier_notice.write_failed');
  }
}
