import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

const workflowRoot = resolve(import.meta.dir, '../../../../.archon/workflows/sdlc');
const triageScript = join(workflowRoot, 'triage', 'scripts', 'validate-contract.py');
const intakeScript = join(workflowRoot, 'lifecycle', 'scripts', 'select-target.py');
const holdsScript = join(workflowRoot, 'merge-queue', 'scripts', 'publish-holds.ts');

let root: string;
let fakeBin: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'archon-sdlc-general-'));
  fakeBin = join(root, 'bin');
  await mkdir(fakeBin);
  const source = join(root, 'fake-gh.ts');
  const output = join(fakeBin, 'gh');
  await writeFile(
    source,
    `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const payloadText = await Bun.stdin.text();
if (process.env.GH_LOG) appendFileSync(process.env.GH_LOG, JSON.stringify({args,payload:payloadText ? JSON.parse(payloadText) : null}) + '\\n');
if (args[0] === 'issue') console.log(process.env.GH_ISSUES ?? '[]');
else if (args[0] === 'pr' && args[1] === 'list') console.log(process.env.GH_PRS ?? '[]');
else if (args[0] === 'api') {
  const endpoint = args.find(value => value.startsWith('repos/')) ?? '';
  const methodIndex = args.indexOf('--method');
  const method = methodIndex < 0 ? 'GET' : args[methodIndex + 1];
  const statePath = process.env.GH_STATE;
  const state = statePath ? JSON.parse(readFileSync(statePath, 'utf8')) : {labels:[],available:[],comments:[]};
  const fieldIndex = args.indexOf('-f');
  const field = fieldIndex < 0 ? '' : args[fieldIndex + 1];
  const payload = payloadText ? JSON.parse(payloadText) : field.startsWith('body=') ? {body:field.slice(5)} : {};
  if (endpoint.endsWith('/comments?per_page=100')) console.log(JSON.stringify([state.comments ?? []]));
  else if (endpoint.includes('/issues/comments/') && method === 'PATCH') {
    const id = Number(endpoint.split('/').at(-1));
    state.comments = (state.comments ?? []).map((comment:any) => comment.id === id ? {...comment,body:payload.body} : comment);
    writeFileSync(statePath, JSON.stringify(state));
  } else if (endpoint.endsWith('/comments') && method === 'POST') {
    state.comments = [...(state.comments ?? []), {id: 99,body:payload.body}];
    writeFileSync(statePath, JSON.stringify(state));
  } else if (endpoint.endsWith('/labels?per_page=100')) console.log(JSON.stringify([state.available.map((name:string) => ({name}))]));
  else if (endpoint.endsWith('/labels') && method === 'POST' && Array.isArray(payload.labels)) {
    const canonical = payload.labels.map((label:string) => state.available.find((name:string) => name.toLowerCase() === label.toLowerCase()) ?? label);
    state.labels = [...new Map([...state.labels,...canonical].map((label:string) => [label.toLowerCase(),label])).values()]; writeFileSync(statePath, JSON.stringify(state));
  } else if (endpoint.endsWith('/labels') && method === 'POST') {
    state.available = [...new Set([...state.available,payload.name])]; writeFileSync(statePath, JSON.stringify(state));
  } else if (endpoint.includes('/labels/') && method === 'DELETE') {
    const name = decodeURIComponent(endpoint.split('/').at(-1)); state.labels = state.labels.filter((label:string) => label.toLowerCase() !== name.toLowerCase()); writeFileSync(statePath, JSON.stringify(state));
  } else if (/\\/issues\\/\\d+$/.test(endpoint)) console.log(JSON.stringify({number:7,html_url:'https://github.com/owner/repo/issues/7',labels:state.labels.map((name:string) => ({name}))}));
}
`
  );
  const built = Bun.spawnSync(['bun', 'build', source, '--compile', '--outfile', output], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (built.exitCode !== 0) throw new Error(built.stderr.toString());
  if (process.platform !== 'win32') await chmod(output, 0o755);
});

afterAll(async () => removeTempTree(root));

function env(values: Record<string, string>): Record<string, string> {
  const result = { ...process.env, ...values } as Record<string, string>;
  for (const key of Object.keys(result)) if (key.toLowerCase() === 'path') delete result[key];
  result[process.platform === 'win32' ? 'Path' : 'PATH'] =
    `${fakeBin}${delimiter}${process.env.PATH ?? ''}`;
  return result;
}

function runPython(
  script: string,
  values: Record<string, string>
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(['uv', 'run', '--no-project', script], {
    env: env(values),
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function stdout(result: ReturnType<typeof Bun.spawnSync>): string {
  return result.stdout?.toString() ?? '';
}

async function triageFixture(
  labels: string[] = ['area-ui']
): Promise<{ artifacts: string; triage: string }> {
  const artifacts = await mkdtemp(join(root, 'triage-'));
  await writeFile(join(artifacts, 'triage.md'), 'evidence\n');
  return {
    artifacts,
    triage: JSON.stringify({
      route: 'deliver',
      summary: 'ready',
      contract: 'READY',
      design_first: false,
      complexity: 'small_bounded',
      proposed_edits: { title: '', body: '' },
      labels,
      blocked_by: [],
      blocked_reason: '',
      issue_repo: 'owner/repo',
      issue_number: 7,
      issue_url: 'https://github.com/owner/repo/issues/7',
    }),
  };
}

describe('caller-owned triage state labels', () => {
  test('keeps a neutral result unlabeled when the mapping is empty', async () => {
    const fixture = await triageFixture();
    const result = runPython(triageScript, {
      ARTIFACTS_DIR: fixture.artifacts,
      INPUTS_TRIAGE: fixture.triage,
      INPUTS_STATE_LABELS: '{}',
      INPUTS_PUBLISH: 'false',
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdout(result))).toMatchObject({ labels: ['area-ui'] });
  });

  test('publishes the mapped state, preserves unrelated labels, and removes only mapped states', async () => {
    const fixture = await triageFixture();
    const statePath = join(fixture.artifacts, 'state.json');
    const log = join(fixture.artifacts, 'gh.jsonl');
    await writeFile(
      statePath,
      JSON.stringify({
        labels: ['Area-UI', 'Team-Blocked', 'archon-noise'],
        available: ['Area-UI', 'Team-Blocked', 'Team-Ready'],
        comments: [],
      })
    );
    const result = runPython(triageScript, {
      ARTIFACTS_DIR: fixture.artifacts,
      INPUTS_TRIAGE: fixture.triage,
      INPUTS_STATE_LABELS: JSON.stringify({ READY: 'team-ready', BLOCKED: 'team-blocked' }),
      INPUTS_PUBLISH: 'true',
      GH_STATE: statePath,
      GH_LOG: log,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdout(result))).toMatchObject({
      labels: ['area-ui', 'team-ready'],
      publication: { published: true, applied_labels: ['Area-UI', 'team-ready'] },
    });
    expect(JSON.parse(await readFile(statePath, 'utf8')).labels.sort()).toEqual([
      'Area-UI',
      'Team-Ready',
      'archon-noise',
    ]);
    const calls = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { args: string[] });
    expect(
      calls.some(
        call => call.args.includes('repos/owner/repo/labels') && call.args.includes('POST')
      )
    ).toBe(false);
    expect(calls.filter(call => call.args.includes('DELETE'))).toHaveLength(1);
    expect(calls.find(call => call.args.includes('DELETE'))?.args.join(' ')).toContain(
      'Team-Blocked'
    );
  });

  test('rejects proposed labels that differ only by case', async () => {
    const fixture = await triageFixture(['area-ui', 'Area-UI']);
    const result = runPython(triageScript, {
      ARTIFACTS_DIR: fixture.artifacts,
      INPUTS_TRIAGE: fixture.triage,
      INPUTS_STATE_LABELS: '{}',
      INPUTS_PUBLISH: 'false',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr?.toString()).toContain('labels must not contain duplicates');
  });

  test('rejects ambiguous and malformed mappings before publication', async () => {
    const fixture = await triageFixture();
    for (const mapping of [{ READY: 'same', BLOCKED: 'SAME' }, { UNKNOWN: 'label' }, []]) {
      const result = runPython(triageScript, {
        ARTIFACTS_DIR: fixture.artifacts,
        INPUTS_TRIAGE: fixture.triage,
        INPUTS_STATE_LABELS: JSON.stringify(mapping),
        INPUTS_PUBLISH: 'true',
      });
      expect(result.exitCode).toBe(1);
    }
  });
});

describe('lifecycle intake state ownership', () => {
  test('uses the same state key domain as triage publication', () => {
    const extract = (script: string, assignment: string): string[] => {
      const program = `import ast,json,sys\nfrom pathlib import Path\nnode=next(n for n in ast.parse(Path(sys.argv[1]).read_text()).body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id==sys.argv[2] for t in n.targets))\nvalues=[k.value for k in (node.value.keys if isinstance(node.value,ast.Dict) else node.value.elts)]\nprint(json.dumps(sorted(values)))`;
      const result = Bun.spawnSync(
        ['uv', 'run', '--no-project', 'python', '-c', program, script, assignment],
        { stdout: 'pipe', stderr: 'pipe' }
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return JSON.parse(stdout(result)) as string[];
    };
    const publicationStates = extract(triageScript, 'STATE_LABEL_METADATA');
    const intakeStates = extract(intakeScript, 'STATES');
    expect(intakeStates).toEqual(publicationStates);
    expect(intakeStates).toEqual([
      'BLOCKED',
      'DESIGN_FIRST',
      'NEEDS_CONTRACT_WORK',
      'NO_ACTION',
      'READY',
    ]);
  });

  test('allows explicit targets with no mapping and safely stops automatic intake', () => {
    const explicit = runPython(intakeScript, {
      INPUTS_TARGET: 'work order',
      INPUTS_STATE_LABELS: '{}',
    });
    expect(JSON.parse(stdout(explicit))).toMatchObject({ found: true, target: 'work order' });
    const automatic = runPython(intakeScript, { INPUTS_TARGET: '', INPUTS_STATE_LABELS: '{}' });
    expect(JSON.parse(stdout(automatic))).toMatchObject({
      found: false,
      reason: 'automatic intake requires state_labels for every state',
    });
  });

  test('treats only configured state labels as touched', () => {
    const result = runPython(intakeScript, {
      INPUTS_TARGET: '',
      INPUTS_STATE_LABELS: JSON.stringify({
        READY: 'team-ready',
        DESIGN_FIRST: 'team-design',
        NEEDS_CONTRACT_WORK: 'team-contract',
        BLOCKED: 'team-blocked',
        NO_ACTION: 'team-closed',
      }),
      GH_ISSUES: JSON.stringify([
        {
          number: 1,
          url: 'https://github.com/owner/repo/issues/1',
          labels: [{ name: 'archon-noise' }],
          createdAt: '2026-01-01',
        },
        {
          number: 2,
          url: 'https://github.com/owner/repo/issues/2',
          labels: [{ name: 'Team-Ready' }],
          createdAt: '2026-01-02',
        },
      ]),
      GH_PRS: '[]',
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdout(result))).toMatchObject({
      target: 'https://github.com/owner/repo/issues/1',
    });
  });
});

describe('hold-comment write boundary', () => {
  const prs = JSON.stringify(['https://github.com/owner/repo/pull/7']);
  const holds = JSON.stringify([
    {
      pr_url: 'https://github.com/owner/repo/pull/7',
      head_sha: 'head-7',
      action: 'hold',
      reasons: ['runtime evidence is stale'],
    },
  ]);

  test('keeps preview read-only even when publication is requested', async () => {
    const log = join(root, 'preview-gh.jsonl');
    const result = Bun.spawnSync([process.execPath, holdsScript], {
      env: env({
        INPUTS_PRS: prs,
        INPUTS_HOLDS: holds,
        INPUTS_MODE: 'preview',
        INPUTS_PUBLISH_HOLDS: 'true',
        GH_LOG: log,
      }),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    expect(await Bun.file(log).exists()).toBe(false);
  });

  test('requires explicit publication and writes only in approve or auto mode', async () => {
    const artifacts = await mkdtemp(join(root, 'holds-'));
    const statePath = join(artifacts, 'state.json');
    const log = join(artifacts, 'gh.jsonl');
    await writeFile(statePath, JSON.stringify({ labels: [], available: [], comments: [] }));
    const disabled = Bun.spawnSync([process.execPath, holdsScript], {
      env: env({
        INPUTS_PRS: prs,
        INPUTS_HOLDS: holds,
        INPUTS_MODE: 'approve',
        INPUTS_PUBLISH_HOLDS: 'false',
        GH_STATE: statePath,
        GH_LOG: log,
      }),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(disabled.exitCode).toBe(0);
    expect(await Bun.file(log).exists()).toBe(false);
    const enabled = Bun.spawnSync([process.execPath, holdsScript], {
      env: env({
        INPUTS_PRS: prs,
        INPUTS_HOLDS: holds,
        INPUTS_MODE: 'auto',
        INPUTS_PUBLISH_HOLDS: 'true',
        GH_STATE: statePath,
        GH_LOG: log,
      }),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(enabled.exitCode, enabled.stderr.toString()).toBe(0);
    expect(JSON.parse(enabled.stdout.toString())).toMatchObject({
      published: true,
      updated: ['https://github.com/owner/repo/pull/7'],
    });
    expect(JSON.parse(await readFile(statePath, 'utf8')).comments[0].body).toStartWith(
      '<!-- archon-merge-hold -->'
    );
  });

  test('edits the existing marker when approve mode clears a hold', async () => {
    const artifacts = await mkdtemp(join(root, 'clear-hold-'));
    const statePath = join(artifacts, 'state.json');
    await writeFile(
      statePath,
      JSON.stringify({
        labels: [],
        available: [],
        comments: [{ id: 4, body: '<!-- archon-merge-hold -->\nold hold' }],
      })
    );
    const clear = JSON.stringify([
      {
        pr_url: 'https://github.com/owner/repo/pull/7',
        head_sha: 'head-8',
        action: 'clear',
        reasons: [],
      },
    ]);
    const result = Bun.spawnSync([process.execPath, holdsScript], {
      env: env({
        INPUTS_PRS: prs,
        INPUTS_HOLDS: clear,
        INPUTS_MODE: 'approve',
        INPUTS_PUBLISH_HOLDS: 'true',
        GH_STATE: statePath,
      }),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      comments: Array<{ body: string }>;
    };
    expect(state.comments).toHaveLength(1);
    expect(state.comments[0].body).toContain('Hold cleared at `head-8`.');
  });

  test('accepts an empty sparse plan and rejects duplicate entries', () => {
    const empty = Bun.spawnSync([process.execPath, holdsScript], {
      env: env({
        INPUTS_PRS: prs,
        INPUTS_HOLDS: '[]',
        INPUTS_MODE: 'auto',
        INPUTS_PUBLISH_HOLDS: 'true',
      }),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(empty.exitCode, empty.stderr.toString()).toBe(0);
    expect(JSON.parse(empty.stdout.toString())).toMatchObject({ published: false, updated: [] });

    const duplicate = Bun.spawnSync([process.execPath, holdsScript], {
      env: env({
        INPUTS_PRS: prs,
        INPUTS_HOLDS: JSON.stringify([...JSON.parse(holds), ...JSON.parse(holds)]),
        INPUTS_MODE: 'auto',
        INPUTS_PUBLISH_HOLDS: 'true',
      }),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(duplicate.exitCode).toBe(1);
    expect(duplicate.stderr.toString()).toContain('holds must not contain duplicate PRs');
  });
});
