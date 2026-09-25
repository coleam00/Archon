import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { join, resolve } from 'node:path';

export interface CompositionRequest {
  /** Full commit IDs, never branch names. */
  original_base: string;
  base: string;
  head: string;
  change: string;
  /** This identifies the entire incoming prefix, not an inferred conflicting PR. */
  base_changes: string[];
  method: 'merge' | 'squash';
  check: { name: string; argv: string[]; environment: string };
}

interface Revision {
  commit: string;
  tree: string;
}

interface Subject extends Revision {
  role: 'change-alone' | 'base-alone' | 'composition';
}

interface Observation {
  subject: Subject;
  command: CompositionRequest['check'];
  check_digest: string;
  exit_code: number;
  git_clean_after: boolean;
  head_after: string;
  log: string;
  started_at: string;
  finished_at: string;
}

export interface CompositionEvidence {
  version: 1;
  repository: string;
  request: CompositionRequest;
  original_base: Revision;
  base: Revision;
  head: Revision;
  merge_bases: string[] | null;
  candidate: Revision | null;
  runtime: { platform: string; arch: string; bun: string; git: string };
  observations: Observation[];
  composition: { exit_code: number; stdout: string; stderr: string } | null;
}

/**
 * Every cause archon-validate's result can carry. Only the comparison script declares
 * `interaction`: the ordinary validate node's schema and implement's omit it. Only
 * ordinary validation and implement declare `incomplete`: the comparison script
 * records an unfinished or unusable comparison as red with an empty cause.
 */
export const VALIDATION_RED_CAUSES = [
  'introduced',
  'inherited',
  'environment',
  'interaction',
  'incomplete',
  '',
] as const;

export interface ValidationVerdict {
  green: boolean;
  red_cause: (typeof VALIDATION_RED_CAUSES)[number];
  summary: string;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Comparison input must be an object.');
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new Error(`Comparison ${field} must be a nonempty string without NUL bytes.`);
  }
  return value;
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Comparison ${field} must be an array.`);
  return value.map((item: unknown) => string(item, field));
}

export function parseCompositionRequest(value: unknown): CompositionRequest {
  const input = object(value);
  const check = object(input.check);
  if (input.method !== 'merge' && input.method !== 'squash') {
    throw new Error(
      'Comparison method must be merge or squash; rebase requires different evidence.'
    );
  }
  const argv = strings(check.argv, 'check.argv');
  if (argv.length === 0) throw new Error('Comparison check.argv must name the project gate.');
  return {
    original_base: string(input.original_base, 'original_base'),
    base: string(input.base, 'base'),
    head: string(input.head, 'head'),
    change: string(input.change, 'change'),
    base_changes: strings(input.base_changes, 'base_changes'),
    method: input.method,
    check: {
      name: string(check.name, 'check.name'),
      argv,
      environment: string(check.environment, 'check.environment'),
    },
  };
}

function git(cwd: string, args: string[], env?: Record<string, string | undefined>): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    // Only local object/worktree commands reach this helper; no credential-bearing remote is used.
    throw new Error(
      `Local git ${args[0]} failed (exit ${result.exitCode}): ${result.stderr.toString().trim()}`
    );
  }
  return result.stdout.toString().trim();
}

function revision(cwd: string, id: string): Revision {
  if (!/^[a-f0-9]+$/.test(id)) throw new Error('Comparison revisions must be full Git object IDs.');
  const commit = git(cwd, ['rev-parse', '--verify', `${id}^{commit}`]);
  if (commit !== id)
    throw new Error('Comparison revisions must be full commit IDs, not abbreviations.');
  return { commit, tree: git(cwd, ['rev-parse', `${commit}^{tree}`]) };
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** A caller supplies current authoritative facts; this never resolves a moving branch for it. */
export function evidenceMatches(
  evidence: CompositionEvidence,
  current: { repository: string; request: CompositionRequest; candidate: Revision }
): boolean {
  return (
    evidence.repository === current.repository &&
    digest(evidence.request) === digest(current.request) &&
    evidence.candidate?.commit === current.candidate.commit &&
    evidence.candidate.tree === current.candidate.tree
  );
}

function passed(observation: Observation): boolean {
  return (
    observation.exit_code === 0 &&
    observation.git_clean_after &&
    observation.head_after === observation.subject.commit
  );
}

export function comparisonVerdict(
  evidence: CompositionEvidence,
  evidencePath: string
): ValidationVerdict {
  const composed = evidence.observations.find(item => item.subject.role === 'composition');
  const change = evidence.observations.find(item => item.subject.role === 'change-alone');
  const base = evidence.observations.find(item => item.subject.role === 'base-alone');
  const identity = `${evidence.request.change} (${evidence.head.commit}) onto ${evidence.request.base_changes.join(', ') || 'the incoming base'} (${evidence.base.commit})`;
  if (!composed) {
    return {
      green: false,
      red_cause: '',
      summary: `No composed gate ran for ${identity}: ${evidence.composition?.exit_code === 1 ? 'local composition conflicted' : 'composition evidence is incomplete'}. Evidence: ${evidencePath}.`,
    };
  }
  const valid =
    evidence.observations.length === 3 &&
    change &&
    base &&
    change.subject.commit === evidence.head.commit &&
    change.subject.tree === evidence.head.tree &&
    base.subject.commit === evidence.base.commit &&
    base.subject.tree === evidence.base.tree &&
    composed.subject.commit === evidence.candidate?.commit &&
    composed.subject.tree === evidence.candidate.tree &&
    evidence.observations.every(
      item =>
        item.git_clean_after &&
        item.head_after === item.subject.commit &&
        item.check_digest === digest(evidence.request.check) &&
        digest(item.command) === item.check_digest
    );
  if (!valid) {
    return {
      green: false,
      red_cause: '',
      summary: `Comparison evidence is incomplete, mismatched, or the gate changed a checkout. No clean-tree verdict for ${identity}. Evidence: ${evidencePath}.`,
    };
  }
  if (passed(composed)) {
    return {
      green: true,
      red_cause: '',
      summary: `${evidence.request.check.name} passed on composed tree ${composed.subject.tree} for ${identity}. Evidence: ${evidencePath}.`,
    };
  }
  const interaction = passed(change) && passed(base);
  const diagnostic = readFileSync(composed.log, 'utf8').trim().slice(-2000);
  return {
    green: false,
    red_cause: interaction ? 'interaction' : 'introduced',
    summary: `${evidence.request.check.name} failed on composed tree ${composed.subject.tree} for ${identity}. ${interaction ? 'Both separate trees passed the same gate; this proves an interaction with the recorded incoming base/prefix, not a pair inferred from file overlap.' : 'Separate green evidence is absent; the cause remains introduced.'} Failing output: ${composed.log}. Evidence: ${evidencePath}.${diagnostic ? `\nGate diagnostic (tail):\n${diagnostic}` : ''}`,
  };
}

/** Execute one authored project command in three clean, pinned worktrees. No remote writes. */
export async function compareComposition(
  cwd: string,
  artifacts: string,
  request: CompositionRequest
): Promise<{ verdict: ValidationVerdict; evidence: CompositionEvidence; path: string }> {
  const original = revision(cwd, request.original_base);
  const base = revision(cwd, request.base);
  const head = revision(cwd, request.head);
  const ancestor = Bun.spawnSync(
    ['git', 'merge-base', '--is-ancestor', original.commit, head.commit],
    { cwd }
  );
  if (ancestor.exitCode !== 0)
    throw new Error('Original comparison base must be an ancestor of the pinned head.');
  mkdirSync(artifacts, { recursive: true });
  const directory = mkdtempSync(join(artifacts, 'comparison-'));
  const path = join(directory, 'evidence.json');
  const evidence: CompositionEvidence = {
    version: 1,
    repository: resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir'])),
    request,
    original_base: original,
    base,
    head,
    merge_bases: null,
    candidate: null,
    runtime: { platform: platform(), arch: arch(), bun: Bun.version, git: git(cwd, ['--version']) },
    observations: [],
    composition: null,
  };
  const composed = Bun.spawnSync(['git', 'merge-tree', '--write-tree', base.commit, head.commit], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  evidence.composition = {
    exit_code: composed.exitCode,
    stdout: join(directory, 'composition.stdout.log'),
    stderr: join(directory, 'composition.stderr.log'),
  };
  writeFileSync(evidence.composition.stdout, composed.stdout);
  writeFileSync(evidence.composition.stderr, composed.stderr);
  writeFileSync(path, JSON.stringify(evidence, null, 2));
  if (composed.exitCode !== 0 && composed.exitCode !== 1) {
    throw new Error(
      `Local composition failed (exit ${composed.exitCode}). Evidence: ${path}.\n${composed.stdout.toString()}${composed.stderr.toString()}`
    );
  }
  evidence.merge_bases = git(cwd, ['merge-base', '--all', base.commit, head.commit]).split('\n');
  if (composed.exitCode === 0) {
    const tree = composed.stdout.toString().trim().split('\n')[0];
    if (!tree || !/^[a-f0-9]+$/.test(tree))
      throw new Error('Local composition did not return a tree ID.');
    const parents =
      request.method === 'merge' ? ['-p', base.commit, '-p', head.commit] : ['-p', base.commit];
    const candidate = git(
      cwd,
      [
        '-c',
        'commit.gpgSign=false',
        'commit-tree',
        tree,
        ...parents,
        '-m',
        'Archon composition validation',
      ],
      {
        ...process.env,
        GIT_AUTHOR_NAME: 'Archon validation',
        GIT_AUTHOR_EMAIL: 'validation@localhost',
        GIT_COMMITTER_NAME: 'Archon validation',
        GIT_COMMITTER_EMAIL: 'validation@localhost',
        GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
      }
    );
    evidence.candidate = { commit: candidate, tree };
    const subjects: Subject[] = [
      { role: 'change-alone', ...head },
      { role: 'base-alone', ...base },
      { role: 'composition', ...evidence.candidate },
    ];
    // One frozen process environment for this comparison. The caller's environment label
    // identifies external dependencies; it is not a claim that databases/network are immutable.
    const env = { ...process.env };
    for (const subject of subjects) {
      const worktree = join(directory, subject.role);
      git(cwd, ['worktree', 'add', '--detach', worktree, subject.commit]);
      try {
        if (git(worktree, ['status', '--porcelain', '--untracked-files=all']) !== '') {
          throw new Error('Comparison worktree is not clean before the gate.');
        }
        const log = join(directory, `${subject.role}.log`);
        const fd = openSync(log, 'wx');
        const started = new Date().toISOString();
        let exitCode: number;
        try {
          const child = Bun.spawn(request.check.argv, {
            cwd: worktree,
            env,
            stdout: fd,
            stderr: fd,
            stdin: 'ignore',
          });
          exitCode = await child.exited;
        } finally {
          closeSync(fd);
        }
        evidence.observations.push({
          subject,
          command: request.check,
          check_digest: digest(request.check),
          exit_code: exitCode,
          git_clean_after: git(worktree, ['status', '--porcelain', '--untracked-files=all']) === '',
          head_after: git(worktree, ['rev-parse', 'HEAD']),
          log,
          started_at: started,
          finished_at: new Date().toISOString(),
        });
        writeFileSync(path, JSON.stringify(evidence, null, 2));
      } finally {
        git(cwd, ['worktree', 'remove', '--force', worktree]);
      }
    }
  }
  writeFileSync(path, JSON.stringify(evidence, null, 2));
  const verdict = comparisonVerdict(evidence, path);
  writeFileSync(join(directory, 'validation.md'), `${verdict.summary}\n`);
  return { verdict, evidence, path };
}

export function readComparisonRequest(path: string): CompositionRequest {
  return parseCompositionRequest(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}
