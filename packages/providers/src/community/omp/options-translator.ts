import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { NodeConfig } from '../../types';

// ─── Thinking level ────────────────────────────────────────────────────────

/**
 * OMP's ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'.
 * Archon's common surface includes 'off' and 'max'. Map:
 *  - 'off' → undefined (no explicit thinkingLevel)
 *  - 'max' → 'xhigh'
 *  - others pass through if already OMP-native
 */
type OmpThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

const OMP_NATIVE_LEVELS: ReadonlySet<OmpThinkingLevel> = new Set<OmpThinkingLevel>([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

function normalizeToThinkingLevel(v: unknown): OmpThinkingLevel | undefined {
  if (typeof v !== 'string') return undefined;
  if (v === 'max') return 'xhigh';
  if (OMP_NATIVE_LEVELS.has(v as OmpThinkingLevel)) return v as OmpThinkingLevel;
  return undefined;
}

export interface ResolvedThinkingLevel {
  level: OmpThinkingLevel | undefined;
  warning?: string;
}

/**
 * Resolve Archon's `effort` / `thinking` node fields to OMP's ThinkingLevel.
 */
export function resolveOmpThinkingLevel(nodeConfig?: NodeConfig): ResolvedThinkingLevel {
  if (!nodeConfig) return { level: undefined };

  const { thinking, effort } = nodeConfig;

  if (thinking === 'off' || effort === 'off') return { level: undefined };

  const thinkingLevel = normalizeToThinkingLevel(thinking);
  if (thinkingLevel) return { level: thinkingLevel };

  const effortLevel = normalizeToThinkingLevel(effort);
  if (effortLevel) return { level: effortLevel };

  if (thinking !== undefined && thinking !== null && typeof thinking === 'object') {
    return {
      level: undefined,
      warning:
        'OMP ignored `thinking` (object form is Claude-specific). Use `effort: low|medium|high|max` in YAML (max → xhigh on OMP).',
    };
  }

  if (typeof thinking === 'string' || typeof effort === 'string') {
    const offender = typeof thinking === 'string' ? thinking : effort;
    return {
      level: undefined,
      warning: `OMP ignored unknown thinking level '${String(offender)}'. Valid: minimal, low, medium, high, xhigh, max, off.`,
    };
  }

  return { level: undefined };
}

// ─── Skills ────────────────────────────────────────────────────────────────

export interface ResolvedSkills {
  paths: string[];
  missing: string[];
}

function skillSearchRoots(cwd: string): string[] {
  const home = process.env.HOME ?? homedir();
  return [
    join(cwd, '.agents', 'skills'),
    join(cwd, '.claude', 'skills'),
    join(home, '.agents', 'skills'),
    join(home, '.claude', 'skills'),
  ];
}

/**
 * Resolve Archon's name-based `skills:` nodeConfig references to absolute
 * directory paths for OMP's additionalSkillPaths.
 */
export function resolveOmpSkills(cwd: string, skillNames: string[] | undefined): ResolvedSkills {
  if (!skillNames || skillNames.length === 0) {
    return { paths: [], missing: [] };
  }

  const roots = skillSearchRoots(cwd);
  const paths: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();

  for (const rawName of skillNames) {
    if (typeof rawName !== 'string' || rawName.length === 0) continue;
    if (seen.has(rawName)) continue;
    seen.add(rawName);

    let found: string | undefined;
    for (const root of roots) {
      const candidate = join(root, rawName);
      if (existsSync(join(candidate, 'SKILL.md'))) {
        found = candidate;
        break;
      }
    }

    if (found) {
      paths.push(found);
    } else {
      missing.push(rawName);
    }
  }

  return { paths, missing };
}
