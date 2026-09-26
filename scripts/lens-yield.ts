/**
 * Lens-yield analysis over review run artifacts (#2898).
 *
 * `archon-review`'s synthesize node writes `review/findings.json` beside its report: every
 * finding it accounted for, with the lenses that sourced it. This script tallies those files
 * so "is a lens earning its slot" is a command over artifacts rather than archaeology through
 * edited-in-place PR comments.
 *
 * Usage:
 *   bun run lens-yield                 # every project under the Archon workspaces directory
 *   bun run lens-yield <root> [root…]  # scan the given directories instead
 */
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Glob } from 'bun';
import { getArchonWorkspacesPath } from '@archon/paths';

/** One record of `review/findings.json`, as `review-synthesize.md` specifies it. */
export interface FindingRecord {
  readonly id: string;
  readonly severity: string;
  readonly sources: readonly string[];
  readonly claim: string;
  readonly status?: string;
  readonly round?: number;
}

export interface FindingsFile {
  readonly path: string;
  readonly findings: readonly FindingRecord[];
}

/** A file that exists but could not be read as findings — reported, never silently skipped. */
export interface UnreadableFile {
  readonly path: string;
  readonly reason: string;
}

export interface LensTally {
  readonly lens: string;
  /** Findings this lens contributed to. */
  readonly findings: number;
  /** Findings no other lens also sourced — the measure that retired the comments lens. */
  readonly sole: number;
  /** Critical or Important among them. */
  readonly blocking: number;
  /** Findings synthesis or a later round disproved, or accepted as declined. */
  readonly disproved: number;
}

const BLOCKING = new Set(['critical', 'important']);
const FINDINGS_GLOB = '**/review/findings.json';

function asFindings(parsed: unknown): FindingRecord[] {
  if (!Array.isArray(parsed)) throw new Error('expected a JSON array of finding records');
  return parsed.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`record ${String(index)} is not an object`);
    }
    const record = entry as Record<string, unknown>;
    const sources = record.sources;
    if (!Array.isArray(sources) || sources.some(source => typeof source !== 'string')) {
      throw new Error(`record ${String(index)} has no 'sources' string array`);
    }
    return {
      id: typeof record.id === 'string' ? record.id : `#${String(index)}`,
      severity: typeof record.severity === 'string' ? record.severity : 'unknown',
      sources: sources as string[],
      claim: typeof record.claim === 'string' ? record.claim : '',
      ...(typeof record.status === 'string' ? { status: record.status } : {}),
      ...(typeof record.round === 'number' ? { round: record.round } : {}),
    };
  });
}

/**
 * The artifacts directory of every project under the Archon workspaces tree that has one.
 * A project that never ran anything has no artifacts directory and contributes nothing.
 *
 * Sorted, like every path list here: `readdir` and glob iteration order differ by platform,
 * and this order reaches the operator's report.
 */
export async function defaultRoots(
  workspaces: string = getArchonWorkspacesPath()
): Promise<string[]> {
  const roots: string[] = [];
  for (const owner of await readdir(workspaces, { withFileTypes: true }).catch(() => [])) {
    if (!owner.isDirectory()) continue;
    const ownerDir = join(workspaces, owner.name);
    for (const project of await readdir(ownerDir, { withFileTypes: true }).catch(() => [])) {
      if (!project.isDirectory()) continue;
      const artifacts = join(ownerDir, project.name, 'artifacts');
      if (existsSync(artifacts)) roots.push(artifacts);
    }
  }
  return roots.sort();
}

/**
 * Read every findings file under `roots`. Roots are artifacts directories, never repository
 * checkouts: the glob walks everything below them. A root that does not exist is reported
 * rather than read as zero findings — a mistyped path must not look like a clean result.
 *
 * Each root's matches are read in sorted order, so both returned lists are ordered by path
 * and the report reads the same on every platform.
 */
export async function collectFindings(
  roots: readonly string[]
): Promise<{ files: FindingsFile[]; unreadable: UnreadableFile[] }> {
  const glob = new Glob(FINDINGS_GLOB);
  const files: FindingsFile[] = [];
  const unreadable: UnreadableFile[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root)) {
      unreadable.push({ path: root, reason: 'no such directory' });
      continue;
    }
    const matches: string[] = [];
    for await (const path of glob.scan({ cwd: root, absolute: true, onlyFiles: true })) {
      matches.push(path);
    }
    for (const path of matches.sort()) {
      if (seen.has(path)) continue;
      seen.add(path);
      try {
        files.push({ path, findings: asFindings(JSON.parse(await Bun.file(path).text())) });
      } catch (error) {
        unreadable.push({ path, reason: (error as Error).message });
      }
    }
  }
  return { files, unreadable };
}

export function tallyLenses(files: readonly FindingsFile[]): LensTally[] {
  const tallies = new Map<
    string,
    { findings: number; sole: number; blocking: number; disproved: number }
  >();
  for (const file of files) {
    for (const finding of file.findings) {
      const lenses = [...new Set(finding.sources)];
      // A declined finding is one the owner refused with a reason synthesis accepted:
      // like a disproved one, it was never a valid finding to act on.
      const disproved = finding.status === 'disproved' || finding.status === 'declined';
      const blocking = BLOCKING.has(finding.severity.toLowerCase()) && !disproved;
      for (const lens of lenses) {
        const tally = tallies.get(lens) ?? { findings: 0, sole: 0, blocking: 0, disproved: 0 };
        tally.findings += 1;
        if (lenses.length === 1) tally.sole += 1;
        if (blocking) tally.blocking += 1;
        if (disproved) tally.disproved += 1;
        tallies.set(lens, tally);
      }
    }
  }
  return [...tallies]
    .map(([lens, tally]) => ({ lens, ...tally }))
    .sort((a, b) => b.findings - a.findings || a.lens.localeCompare(b.lens));
}

export function formatReport(
  files: readonly FindingsFile[],
  tallies: readonly LensTally[],
  unreadable: readonly UnreadableFile[]
): string {
  const total = files.reduce((sum, file) => sum + file.findings.length, 0);
  const lines = [`${String(files.length)} review(s), ${String(total)} finding(s)`, ''];
  if (tallies.length === 0) {
    lines.push('No attributed findings found.');
  } else {
    lines.push('lens              findings  sole  blocking  disproved');
    for (const tally of tallies) {
      lines.push(
        tally.lens.padEnd(18) +
          String(tally.findings).padStart(8) +
          String(tally.sole).padStart(6) +
          String(tally.blocking).padStart(10) +
          String(tally.disproved).padStart(11)
      );
    }
  }
  if (unreadable.length > 0) {
    lines.push('', `${String(unreadable.length)} file(s) could not be read:`);
    for (const file of unreadable) lines.push(`  ${file.path} — ${file.reason}`);
  }
  return lines.join('\n');
}

if (import.meta.main) {
  const roots = process.argv.slice(2);
  const { files, unreadable } = await collectFindings(
    roots.length > 0 ? roots : await defaultRoots()
  );
  console.log(formatReport(files, tallyLenses(files), unreadable));
}
