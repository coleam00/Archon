import { describe, test, expect } from 'bun:test';
import { homedir } from 'node:os';
import { buildSnapshot, SnapshotBuildError } from './snapshot';
import { parseSymphonyConfig } from './parse';
import { resolveEnvIndirection, expandEnvAndHome } from './coerce';

const baseEnv: NodeJS.ProcessEnv = {
  LINEAR_API_KEY: 'secret-token',
  GITHUB_TOKEN: 'gh-token',
};

describe('resolveEnvIndirection', () => {
  test('returns env value for $VAR form', () => {
    expect(resolveEnvIndirection('$X', { X: 'secret' })).toBe('secret');
    expect(resolveEnvIndirection('${X}', { X: 'secret' })).toBe('secret');
  });
  test('returns literal when not a $VAR pattern', () => {
    expect(resolveEnvIndirection('literal', {})).toBe('literal');
  });
  test('returns empty string when env missing', () => {
    expect(resolveEnvIndirection('$MISSING', {})).toBe('');
  });
});

describe('expandEnvAndHome', () => {
  test('expands ~/path', () => {
    const out = expandEnvAndHome('~/foo');
    expect(out).toBe(`${homedir()}/foo`);
  });
  test('expands $VAR inline', () => {
    expect(expandEnvAndHome('/data/$NAME/x', { NAME: 'ws' })).toBe('/data/ws/x');
  });
});

describe('buildSnapshot', () => {
  test('throws SnapshotBuildError when no trackers configured', () => {
    expect(() => buildSnapshot({ trackers: [] }, baseEnv)).toThrow(SnapshotBuildError);
    expect(() => buildSnapshot({}, baseEnv)).toThrow(SnapshotBuildError);
  });

  test('builds a Linear-only snapshot with default fill-in', () => {
    const yaml = `
trackers:
  - kind: linear
    api_key: $LINEAR_API_KEY
    project_slug: my-slug
`;
    const snap = buildSnapshot(parseSymphonyConfig(yaml), baseEnv);
    expect(snap.trackers).toHaveLength(1);
    const t = snap.trackers[0];
    if (t?.kind !== 'linear') throw new Error('expected linear tracker');
    expect(t.apiKey).toBe('secret-token');
    expect(t.projectSlug).toBe('my-slug');
    expect(t.endpoint).toBe('https://api.linear.app/graphql');
    expect(t.activeStates).toEqual(['Todo', 'In Progress']);
    expect(t.terminalStates).toEqual(['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done']);
    expect(snap.dispatch.maxConcurrent).toBe(10);
    expect(snap.dispatch.retry.failureBaseDelayMs).toBe(10_000);
    expect(snap.polling.intervalMs).toBe(30_000);
  });

  test('builds a multi-tracker snapshot (Linear + GitHub)', () => {
    const yaml = `
trackers:
  - kind: linear
    api_key: $LINEAR_API_KEY
    project_slug: smoke
  - kind: github
    token: $GITHUB_TOKEN
    owner: Ddell12
    repo: archon-symphony
`;
    const snap = buildSnapshot(parseSymphonyConfig(yaml), baseEnv);
    expect(snap.trackers).toHaveLength(2);
    const linear = snap.trackers.find(t => t.kind === 'linear');
    const github = snap.trackers.find(t => t.kind === 'github');
    expect(linear?.kind).toBe('linear');
    expect(github?.kind).toBe('github');
    if (github?.kind === 'github') {
      expect(github.token).toBe('gh-token');
      expect(github.owner).toBe('Ddell12');
      expect(github.repo).toBe('archon-symphony');
      expect(github.activeStates).toEqual(['open']);
      expect(github.terminalStates).toEqual(['closed']);
    }
  });

  test('drops a tracker missing required fields without aborting the snapshot', () => {
    const yaml = `
trackers:
  - kind: linear
    api_key: $LINEAR_API_KEY
    project_slug: ok
  - kind: github
    owner: Ddell12
    # missing token, missing repo
`;
    const snap = buildSnapshot(parseSymphonyConfig(yaml), baseEnv);
    expect(snap.trackers).toHaveLength(1);
    expect(snap.trackers[0]?.kind).toBe('linear');
  });

  test('parses dispatch config and per-state caps with lowercase keys', () => {
    const yaml = `
trackers:
  - kind: linear
    api_key: $LINEAR_API_KEY
    project_slug: p
dispatch:
  max_concurrent: 4
  max_concurrent_by_state:
    'In Progress': 2
    Todo: 5
  retry:
    continuation_delay_ms: 7000
    failure_base_delay_ms: 25000
    max_backoff_ms: 250000
`;
    const snap = buildSnapshot(parseSymphonyConfig(yaml), baseEnv);
    expect(snap.dispatch.maxConcurrent).toBe(4);
    expect(snap.dispatch.maxConcurrentByState).toEqual({ 'in progress': 2, todo: 5 });
    expect(snap.dispatch.retry.continuationDelayMs).toBe(7000);
    expect(snap.dispatch.retry.failureBaseDelayMs).toBe(25000);
    expect(snap.dispatch.retry.maxBackoffMs).toBe(250000);
  });

  test('round-trips state_workflow_map and codebases', () => {
    const yaml = `
trackers:
  - kind: linear
    api_key: $LINEAR_API_KEY
    project_slug: p
state_workflow_map:
  Todo: archon-feature-development
  "In Progress": archon-continue
codebases:
  - tracker: linear
    repository: Ddell12/archon-symphony
    codebase_id: cb-1
  - tracker: github
    repository: Ddell12/archon-symphony
    codebase_id: null
`;
    const snap = buildSnapshot(parseSymphonyConfig(yaml), baseEnv);
    expect(snap.stateWorkflowMap).toEqual({
      Todo: 'archon-feature-development',
      'In Progress': 'archon-continue',
    });
    expect(snap.codebases).toHaveLength(2);
    expect(snap.codebases[0]).toEqual({
      tracker: 'linear',
      repository: 'Ddell12/archon-symphony',
      codebaseId: 'cb-1',
    });
    expect(snap.codebases[1]?.codebaseId).toBeNull();
  });
});
