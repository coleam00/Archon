import { describe, expect, it } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { trackTempRoots } from '@archon/paths/test-utils';
import { parseWorkflow } from '../loader';
import { parseFixtureFile } from '../fixture-runner';
import { TERMINAL_WORKFLOW_STATUSES } from '../schemas/workflow-run';

const ROOT = join(import.meta.dir, '../../../..');
const PACK = join(ROOT, '.archon/workflows/sdlc/discoveries');
const track = trackTempRoots();
const responseSchema = z.object({
  steps: z.array(
    z.object({ name: z.string(), code: z.number(), stdout: z.string(), stderr: z.string() })
  ),
  files: z.record(z.string(), z.string()),
  calls: z.array(z.array(z.string())),
  status: z.string(),
  head: z.string(),
  classifications: z.array(z.string()),
  verdicts: z.array(z.string()),
  terminal_statuses: z.array(z.string()),
});
const documentSchema = z.object({
  publication_authorized: z.literal(false),
  forge: z.object({ available: z.boolean(), host: z.string(), path: z.string() }),
  proposals: z.array(
    z.object({
      classification: z.string(),
      evidence_status: z.string(),
      model_verdict: z.string(),
      actionable: z.boolean(),
      publication_authorized: z.literal(false),
      marker: z.string().nullable(),
      title: z.string(),
      evidence_refs: z.array(z.object({ path: z.string(), line: z.number() })),
    })
  ),
});
type Result = z.infer<typeof responseSchema>;
const record = {
  title: 'Example finding',
  claim: 'Fixture hypothesis',
  evidence: ['AGENTS.md:1'],
  source_node: 'review-code',
};
const revalidation = {
  item_index: 0,
  verdict: 'supported',
  evidence_refs: [{ path: 'AGENTS.md', line: 1 }],
  note: 'Simulated judgment',
};
const classification = {
  item_index: 0,
  classification: 'new',
  target_item: null,
  public_title: 'Public example',
  public_summary: 'Source-backed problem description.',
  disclosure_safe: true,
  rationale: 'Needs review.',
};
const search = { item_index: 0, forge_checked: false, matches: [] };

async function run(overrides: Record<string, unknown> = {}): Promise<Result> {
  const directory = track(await mkdtemp(join(tmpdir(), 'archon-discoveries-')));
  const child = Bun.spawn(
    [
      process.platform === 'win32' ? 'python' : 'python3',
      join(import.meta.dir, 'discovery-proposals-harness.py'),
      directory,
      join(PACK, 'scripts'),
    ],
    {
      stdin: new Blob([
        JSON.stringify({
          records: [record],
          revalidation: [revalidation],
          search: [search],
          classification: [classification],
          ...overrides,
        }),
      ]),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    }
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  return responseSchema.parse(JSON.parse(stdout));
}
function proposals(result: Result) {
  expect(result.steps.map(s => s.code)).toEqual([0, 0, 0]);
  expect(result.status).toBe('');
  return documentSchema.parse(JSON.parse(result.files['discovery-proposals.json']!));
}
function refused(result: Result, node: string, evidence: string) {
  expect(result.steps.at(-1)).toMatchObject({ name: node, code: 1 });
  expect(result.steps.at(-1)?.stderr).toContain(evidence);
  expect(result.files).not.toHaveProperty('discovery-proposals.json');
}

const nativeRun = { run_id: 'prior-run', run_only: true };
const normalizedSchema = z.array(
  z.object({
    item_index: z.number(),
    claim: z.string(),
    evidence: z.array(z.string()),
    source_nodes: z.array(z.string()),
    marker: z.string().nullable(),
  })
);
function normalized(result: Result) {
  expect(result.steps[0]?.code).toBe(0);
  return normalizedSchema.parse(JSON.parse(result.files['discoveries/normalized.json']!));
}

describe('native discovery run resolution through the real owning script', () => {
  it('prefers canonical consolidation, including an empty adjudication, over raw sidecars', async () => {
    for (const records of [[{ ...record, source_nodes: ['code', 'tests'] }], []]) {
      const result = await run({
        ...nativeRun,
        resolve_only: true,
        artifact_files: {
          'discoveries/review-code.json': [{ title: 'Malformed raw' }],
          'nested/discoveries.json': [{ title: 'Unrelated' }],
          'discoveries.json': records,
        },
      });
      expect(normalized(result)).toHaveLength(records.length);
      expect(result.terminal_statuses).toEqual([...TERMINAL_WORKFLOW_STATUSES]);
      expect(result.calls.filter(c => c[0] === 'archon')).toEqual([
        ['archon', 'workflow', 'get', 'prior-run', '--json'],
      ]);
    }
  }, 20_000);

  it('collects native raw arrays, merges exact repeats, and retains same-title defects', async () => {
    const result = await run({
      ...nativeRun,
      resolve_only: true,
      artifact_files: {
        'discoveries/regress.json': [{ ...record, title: 'Reproduced check defect' }],
        'discoveries/review code.json': [
          { ...record, title: 'Reproduced check defect', source_node: 'code' },
          { ...record, title: 'Reproduced check defect', claim: 'A different defect' },
          { ...record, title: 'Reproduced check defect', evidence: ['folder/source.txt:1'] },
        ],
      },
    });
    const items = normalized(result);
    expect(items.map(i => i.item_index)).toEqual([0, 1, 2]);
    expect(items[0]?.source_nodes).toEqual(['code', 'review-code']);
    expect(items[1]?.claim).toBe('A different defect');
    expect(items[2]?.evidence).toEqual(['folder/source.txt:1']);
  }, 20_000);

  it('renders an empty proposal set for a readable run without discoveries', async () => {
    for (const status of TERMINAL_WORKFLOW_STATUSES) {
      const result = await run({
        ...nativeRun,
        cli_response: { status },
        artifact_files: { 'report.md': 'No discoveries' },
        revalidation: [],
        search: [],
        classification: [],
      });
      expect(proposals(result).proposals).toEqual([]);
    }
  }, 20_000);

  for (const input of [
    { cli_exit: 2 },
    { cli_error: 'timeout' },
    { cli_error: 'missing' },
    { cli_raw: 'not JSON' },
    { cli_raw: '[]' },
    { cli_response: { id: 'different-run' } },
    ...['pending', 'running', 'paused', null, 'unknown'].map(status => ({
      cli_response: { status },
    })),
    { cli_response: { artifacts_dir: null } },
    { cli_response: { artifacts_dir: 'relative' } },
    { missing_storage: true },
    { cli_response: { leave_behind: null } },
    { cli_response: { leave_behind: { artifactFiles: [7] } } },
    { cli_response: { leave_behind: { artifactFiles: ['discoveries.json'] } } },
    { artifact_files: { 'discoveries.json': [{ ...record, evidence: 'not an array' }] } },
    { artifact_files: { 'discoveries.json': {}, 'discoveries/regress.json': [record] } },
    { artifact_files: { 'discoveries/regress.json': [{ ...record, evidence: 'not an array' }] } },
    {
      artifact_files: {
        'discoveries/a.json': [record],
        'discoveries/b.json': [{ ...record, relation: 'scope_conflict' }],
      },
    },
    {
      artifact_files: { 'discoveries/regress.json': [record] },
      cli_response: { leave_behind: { artifactFiles: [] } },
    },
    {
      artifact_files: { 'discoveries.json': [record], 'discoveries/regress.json': [record] },
      cli_response: { leave_behind: { artifactFiles: ['discoveries/regress.json'] } },
    },
  ]) {
    it(
      'refuses unavailable or ambiguous input: ' + JSON.stringify(input),
      async () => {
        refused(await run({ ...nativeRun, ...input }), 'resolve-input', 'resolve-input:');
      },
      20_000
    );
  }

  for (const filename of [
    '/tmp/discoveries.json',
    '../discoveries.json',
    'discoveries/../outside.json',
    'C:/private.json',
    'C:private.json',
    '\\\\host\\share\\private.json',
    'discoveries\\regress.json',
    'discoveries//regress.json',
    './discoveries.json',
    'discoveries/evil\u0000.json',
  ]) {
    it(
      'rejects untrusted filenames even alongside canonical input: ' + JSON.stringify(filename),
      async () => {
        refused(
          await run({
            ...nativeRun,
            artifact_files: { 'discoveries.json': [record] },
            cli_response: { leave_behind: { artifactFiles: ['discoveries.json', filename] } },
          }),
          'resolve-input',
          'unsafe artifact filename'
        );
      },
      20_000
    );
  }

  it('refuses duplicate filenames and actual symlink or junction escapes', async () => {
    refused(
      await run({
        ...nativeRun,
        cli_response: {
          leave_behind: { artifactFiles: ['discoveries.json', 'discoveries.json'] },
        },
      }),
      'resolve-input',
      'ambiguous duplicate'
    );
    refused(
      await run({
        ...nativeRun,
        symlink_escape: true,
        cli_response: {
          leave_behind: { artifactFiles: ['discoveries/regress.json'] },
        },
      }),
      'resolve-input',
      'symlink escapes'
    );
  }, 20_000);

  it('uses claim and evidence in stable repository-scoped markers', async () => {
    const input = { resolve_only: true, remote: 'https://github.com/example/repo.git' };
    const first = normalized(await run(input))[0]?.marker;
    const repeated = normalized(
      await run({
        ...input,
        records: [
          {
            ...record,
            title: ' EXAMPLE finding ',
            claim: 'Fixture   hypothesis',
            evidence: [' AGENTS.md:1 ', 'AGENTS.md:1'],
            source_node: 'different producer',
          },
        ],
      })
    )[0]?.marker;
    expect(first).toBeString();
    expect(repeated).toBe(first);
    for (const records of [
      [{ ...record, claim: 'Different claim' }],
      [{ ...record, evidence: ['folder/source.txt:1'] }],
    ]) {
      expect(normalized(await run({ ...input, records }))[0]?.marker).not.toBe(first);
    }
    const other = await run({
      ...input,
      remote: 'https://github.com/other/repo.git',
      gh_identity: 'other/repo',
      gh_repository: 'other/repo',
    });
    expect(normalized(other)[0]?.marker).not.toBe(first);
  }, 30_000);
});

describe('discovery proposals real scripts (agent judgments and gh transport simulated)', () => {
  it('renders useful local proposals without a forge, identity guess, or publication authorization', async () => {
    const result = await run();
    const doc = proposals(result);
    expect(doc.forge).toEqual({ available: false, host: '', path: '' });
    expect(doc.proposals[0]).toMatchObject({
      classification: 'new',
      actionable: false,
      marker: null,
      evidence_status: 'source-bound',
    });
    expect(result.calls.some(c => c[0] === 'gh')).toBe(false);
    expect(result.files['discoveries/normalized.json']).toContain('review-code');
    expect(result.files['discovery-proposals.md']).toContain('Publication unavailable');
    const parsed = parseWorkflow(
      await Bun.file(join(PACK, 'archon-discoveries.yaml')).text(),
      'archon-discoveries.yaml'
    );
    if (!parsed.workflow) throw new Error(JSON.stringify(parsed.error));
    const classifyNode = parsed.workflow.nodes.find(n => n.id === 'classify');
    const revalidateNode = parsed.workflow.nodes.find(n => n.id === 'revalidate');
    if (classifyNode?.kind !== 'agent' || revalidateNode?.kind !== 'agent') {
      throw new Error('Discovery judgments must be agent nodes');
    }
    expect(classifyNode.output_format).toMatchObject({
      properties: {
        entries: { items: { properties: { classification: { enum: result.classifications } } } },
      },
    });
    expect(revalidateNode.output_format).toMatchObject({
      properties: { entries: { items: { properties: { verdict: { enum: result.verdicts } } } } },
    });
  }, 20_000);

  for (const name of ['four-classes', 'duplicate']) {
    it(
      'executes ' + name + ' scenario against real source and simulated GitHub reads',
      async () => {
        const fixture = parseFixtureFile(
          await Bun.file(join(PACK, 'fixtures/' + name + '.scenario.yaml')).text(),
          name
        );
        const result = await run({
          records: JSON.parse(
            await Bun.file(join(ROOT, fixture.declaration.inputs!.discovery_artifact!)).text()
          ) as unknown,
          remote: 'https://github.com/example/repo.git',
          revalidation: z.object({ entries: z.array(z.unknown()) }).parse(fixture.stubs.revalidate)
            .entries,
          search: z
            .object({ entries: z.array(z.unknown()) })
            .parse(fixture.stubs['search-existing']).entries,
          classification: z.object({ entries: z.array(z.unknown()) }).parse(fixture.stubs.classify)
            .entries,
        });
        const doc = proposals(result);
        expect(doc.proposals.map(p => p.classification)).toEqual(
          name === 'four-classes' ? result.classifications : ['duplicate']
        );
        expect(doc.proposals.filter(p => p.actionable).map(p => p.classification)).toEqual(
          name === 'four-classes' ? ['update-existing', 'new'] : []
        );
        expect(result.calls.filter(c => c[0] === 'gh')).toEqual([
          ['gh', 'repo', 'view', 'github.com/example/repo', '--json', 'nameWithOwner'],
        ]);
      },
      20_000
    );
  }

  for (const refs of [
    [],
    [{ path: 'AGENTS.md', line: 999 }],
    [{ path: '../outside', line: 1 }],
    [{ path: '/private/file', line: 1 }],
    [{ path: 'C:\\private\\file', line: 1 }],
    [{ path: 'folder', line: 1 }],
    [{ path: 'missing', line: 1 }],
    [
      { path: 'AGENTS.md', line: 1 },
      { path: 'missing', line: 1 },
    ],
  ]) {
    it(
      'keeps unsupported citations unverified: ' + JSON.stringify(refs),
      async () => {
        const doc = proposals(
          await run({
            remote: 'https://github.com/example/repo.git',
            search: [{ ...search, forge_checked: true }],
            revalidation: [{ ...revalidation, evidence_refs: refs }],
          })
        );
        expect(doc.proposals[0]).toMatchObject({
          classification: 'new',
          model_verdict: 'supported',
          evidence_status: 'unverified',
          actionable: false,
          evidence_refs: [],
        });
      },
      20_000
    );
  }

  it('preserves an inconclusive model judgment even when every citation resolves', async () => {
    const doc = proposals(
      await run({
        remote: 'https://github.com/example/repo.git',
        search: [{ ...search, forge_checked: true }],
        revalidation: [{ ...revalidation, verdict: 'inconclusive' }],
      })
    );
    expect(doc.proposals[0]).toMatchObject({
      model_verdict: 'inconclusive',
      evidence_status: 'source-bound',
      actionable: false,
    });
  }, 20_000);

  it('rejects a stale classification when evidence was only missing', async () => {
    refused(
      await run({
        revalidation: [{ ...revalidation, evidence_refs: [] }],
        classification: [{ ...classification, classification: 'stale' }],
      }),
      'render-proposals',
      'disproved model verdict'
    );
  }, 20_000);

  for (const move of ['check-evidence', 'render-proposals']) {
    it(
      'rejects actual HEAD movement before ' + move,
      async () => {
        refused(await run({ move }), move, 'source revision moved');
      },
      20_000
    );
  }

  for (const input of [
    { raw: 'not JSON' },
    { raw: '{}' },
    { records: [null] },
    { records: [{ title: 'Missing claim' }] },
    { missing: true },
  ]) {
    it(
      'rejects malformed or missing artifact: ' + JSON.stringify(input),
      async () => {
        refused(await run(input), 'resolve-input', 'resolve-input:');
      },
      20_000
    );
  }

  it('requires exactly one explicit input', async () => {
    refused(await run({ run_id: 'prior-run' }), 'resolve-input', 'exactly one');
    refused(await run({ no_input: true }), 'resolve-input', 'exactly one');
  }, 20_000);

  it('merges exact normalized findings and preserves producer attribution', async () => {
    const result = await run({
      records: [record, { ...record, title: ' EXAMPLE   finding ', source_node: 'other' }],
    });
    expect(proposals(result).proposals).toHaveLength(1);
    expect(JSON.parse(result.files['discoveries/normalized.json']!)[0].source_nodes).toEqual([
      'other',
      'review-code',
    ]);
  }, 20_000);

  it('rejects repeated agent item indices instead of silently overwriting an entry', async () => {
    refused(
      await run({ revalidation: [revalidation, revalidation] }),
      'check-evidence',
      'exactly one revalidation'
    );
    refused(
      await run({ classification: [classification, classification] }),
      'render-proposals',
      'exactly one entry'
    );
  }, 20_000);

  for (const text of [
    'C:\\private\\report.md',
    '/private/evaluator.md',
    'See file:///tmp/result',
    'See $ARTIFACTS_DIR',
    '<img src=/private/report.md>',
    '[evidence](file%3A%2F%2F%2Fprivate%2Freport.md)',
    '[evidence](&#47;private/report.md)',
    'See ${ARTIFACTS_DIR}',
  ]) {
    it(
      'rejects absolute paths in public prose: ' + text,
      async () => {
        refused(
          await run({ classification: [{ ...classification, public_summary: text }] }),
          'render-proposals',
          'local absolute path'
        );
      },
      20_000
    );
  }

  it('accepts an HTTP route in a public defect description', async () => {
    const summary = 'POST /api/items with malformed Content-Length drops the connection.';
    const result = await run({
      classification: [{ ...classification, public_title: summary, public_summary: summary }],
    });
    expect(proposals(result).proposals[0].title).toBe(summary);
  }, 20_000);

  it('keeps raw private content out of rendered proposals and respects disclosure refusal', async () => {
    const result = await run({
      records: [
        {
          ...record,
          title: 'Private evaluator at C:\\private\\input.json',
          claim: 'Confidential evaluator content',
          source_node: 'private-node',
        },
      ],
    });
    proposals(result);
    for (const file of ['discovery-proposals.json', 'discovery-proposals.md']) {
      expect(result.files[file]).not.toContain('private');
      expect(result.files[file]).not.toContain('Confidential');
    }
    refused(
      await run({ classification: [{ ...classification, disclosure_safe: false }] }),
      'render-proposals',
      'public disclosure'
    );
  }, 20_000);

  it('allows public HTTPS citations without mistaking their scheme for a drive path', async () => {
    const summary = 'See https://github.com/example/repo/issues/1 for public context.';
    proposals(await run({ classification: [{ ...classification, public_summary: summary }] }));
  }, 20_000);

  it('keeps failed GitHub reads unavailable and refuses fabricated search results', async () => {
    const input = { remote: 'https://github.com/example/repo.git', gh_exit: 1 };
    expect(proposals(await run(input)).forge.available).toBe(false);
    refused(
      await run({ ...input, search: [{ ...search, forge_checked: true }] }),
      'render-proposals',
      'forge is unavailable'
    );
  }, 20_000);

  it('rejects mismatched repository identity from gh', async () => {
    refused(
      await run({ remote: 'https://github.com/example/repo.git', gh_identity: 'other/repo' }),
      'resolve-input',
      'different identity'
    );
  }, 20_000);

  it('does not treat a non-GitHub origin as a configured GitHub forge', async () => {
    const result = await run({ remote: 'https://gitlab.com/example/repo.git' });
    expect(proposals(result).forge).toEqual({ available: false, host: '', path: '' });
    expect(result.calls.some(c => c[0] === 'gh')).toBe(false);
  }, 20_000);

  it('rejects a target URL whose repository or number disagrees with the search identity', async () => {
    const target = { number: 1, url: 'https://github.com/other/repo/issues/1' };
    refused(
      await run({
        remote: 'https://github.com/example/repo.git',
        search: [{ ...search, forge_checked: true, matches: [target] }],
        classification: [{ ...classification, classification: 'duplicate', target_item: target }],
      }),
      'render-proposals',
      'configured repository'
    );
  }, 20_000);

  it('keeps markers stable across reruns and excludes embedded remote credentials', async () => {
    const first = await run({ remote: 'https://credential@github.com/example/repo.git' });
    const second = await run({ remote: 'git@github.com:example/repo.git' });
    expect(proposals(first).proposals[0]?.marker).toBe(proposals(second).proposals[0]?.marker);
    expect(first.files['discovery-proposals.json']).not.toContain('credential');
  }, 20_000);
});
