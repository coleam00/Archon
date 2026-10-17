import { isFinalReleaseTag } from './release-tags';

export const SCHEMA_REPO_PATH = 'migrations/000_combined.sql';

/**
 * Keep the oldest final release per schema blob: releases without schema changes
 * represent the same installed schema and need only one upgrade baseline.
 */
export function defaultBaselines(
  git: (...args: string[]) => { ok: boolean; stdout: string }
): string[] {
  const tags = git('tag', '--sort=creatordate').stdout.split('\n').filter(isFinalReleaseTag);
  const oldestTagPerSchema = new Map<string, string>();
  let withoutSchema = 0;

  for (const tag of tags) {
    const blob = git('rev-parse', `${tag}:${SCHEMA_REPO_PATH}`);
    if (!blob.ok) {
      withoutSchema++;
      continue;
    }
    const id = blob.stdout.trim();
    if (!oldestTagPerSchema.has(id)) oldestTagPerSchema.set(id, tag);
  }

  if (withoutSchema > 0) {
    console.log(
      `note: ${withoutSchema} tag(s) predate ${SCHEMA_REPO_PATH} and cannot be a baseline`
    );
  }
  console.log(
    `note: ${tags.length - withoutSchema} tag(s) carry ${oldestTagPerSchema.size} distinct schema version(s)`
  );
  return [...oldestTagPerSchema.values()];
}
