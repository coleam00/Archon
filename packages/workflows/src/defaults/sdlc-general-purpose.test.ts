import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

const workflowRoot = resolve(import.meta.dir, '../../../../.archon/workflows/sdlc');
const triageScript = join(workflowRoot, 'triage', 'scripts', 'verdict.ts');
const shipOutcomeScript = join(workflowRoot, 'ship', 'scripts', 'outcome.ts');
const intakeScript = join(workflowRoot, 'lifecycle', 'scripts', 'select-target.py');
const closeTargetScript = join(workflowRoot, 'lifecycle', 'scripts', 'close-target.py');
const bindScript = join(workflowRoot, 'lifecycle', 'scripts', 'bind-delivered-pr.py');
const refreshScript = join(workflowRoot, 'merge-queue', 'scripts', 'refresh-merge.py');
const holdsScript = join(workflowRoot, 'merge-queue', 'scripts', 'publish-holds.ts');
const publishPrScript = join(workflowRoot, 'pr', 'scripts', 'publish-pr.ts');

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
const fakeView = process.env.GH_PR_VIEW;
const mergeSeqFile = process.env.GH_MERGE_SEQ_FILE;
const fakeBaseSha = process.env.GH_BASE_SHA ?? '';
const fakeBehindBy = process.env.GH_BEHIND_BY ?? '0';
const apiEndpoint = args.find((value: string) => value.startsWith('repos/')) ?? '';
if (process.env.GH_LOG) appendFileSync(process.env.GH_LOG, JSON.stringify({args,payload:payloadText ? JSON.parse(payloadText) : null}) + '\\n');
const statePath = process.env.GH_STATE;
const readState = () => statePath ? JSON.parse(readFileSync(statePath, 'utf8')) : {labels:[],available:[],comments:[]};
if (args[0] === 'label' && args[1] === 'list') console.log(JSON.stringify(readState().available.map((name:string) => ({name}))));
else if (args[0] === 'label' && args[1] === 'create') {
  const state = readState(); state.available = [...new Set([...state.available,args[2]])]; writeFileSync(statePath, JSON.stringify(state));
}
else if (args[0] === 'issue' && args[1] === 'edit') {
  // Like gh: a label matches regardless of case, and an added one takes the repository's spelling.
  const state = readState();
  const values = (flag:string) => args.flatMap((value:string, index:number) => args[index - 1] === flag ? [value] : []);
  const removed = values('--remove-label').map((label:string) => label.toLowerCase());
  const added = values('--add-label').map((label:string) => state.available.find((name:string) => name.toLowerCase() === label.toLowerCase()) ?? label);
  state.labels = [...new Map([...state.labels.filter((label:string) => !removed.includes(label.toLowerCase())),...added].map((label:string) => [label.toLowerCase(),label])).values()];
  writeFileSync(statePath, JSON.stringify(state));
}
else if (args[0] === 'issue' && args[1] === 'view') console.log(JSON.stringify({state: process.env.GH_ISSUE_STATE ?? 'OPEN'}));
else if (args[0] === 'issue' && args[1] === 'close') {}
else if (args[0] === 'pr' && args[1] === 'view' && fakeView) {
  // A full pull request record; GH_MERGE_SEQ_FILE replays mergeStateStatus reads in order.
  const view = JSON.parse(fakeView);
  if (mergeSeqFile) {
    const seq = JSON.parse(readFileSync(mergeSeqFile, 'utf8')) as string[];
    view.mergeStateStatus = seq.length > 1 ? seq.shift() : seq[0];
    writeFileSync(mergeSeqFile, JSON.stringify(seq));
  }
  console.log(JSON.stringify(view));
}
else if (args[0] === 'pr' && args[1] === 'view') console.log(JSON.stringify({state: JSON.parse(process.env.GH_PR_STATES ?? '{}')[args[2]] ?? 'OPEN'}));
else if (args[0] === 'api' && apiEndpoint.includes('/branches/')) console.log(fakeBaseSha);
else if (args[0] === 'api' && apiEndpoint.includes('/compare/')) console.log(fakeBehindBy);
else if (args[0] === 'issue') {
  // Like gh: the listing is newest first and --limit truncates it.
  const issues = JSON.parse(process.env.GH_ISSUES ?? '[]');
  const limit = args.indexOf('--limit');
  console.log(JSON.stringify(limit < 0 ? issues : issues.slice(0, Number(args[limit + 1]))));
}
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
  values: Record<string, string>,
  cwd?: string
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(['uv', 'run', '--no-project', script], {
    env: env(values),
    stdout: 'pipe',
    stderr: 'pipe',
    ...(cwd ? { cwd } : {}),
  });
}

function stdout(result: ReturnType<typeof Bun.spawnSync>): string {
  return result.stdout?.toString() ?? '';
}

/** The verdict node's bindings for a READY deliver verdict on owner/repo#7. */
function triageVerdict(areaLabels: string[] = ['area-ui']): Record<string, string> {
  return {
    INPUTS_CONTRACT: 'READY',
    INPUTS_ROUTE: 'deliver',
    INPUTS_DESIGN_FIRST: 'false',
    INPUTS_COMPLEXITY: 'small',
    INPUTS_ITEM: JSON.stringify({ repo: { host: 'github.com', path: 'owner/repo' }, number: 7 }),
    INPUTS_AREA_LABELS: JSON.stringify(areaLabels),
    INPUTS_PROPOSED_EDITS: JSON.stringify({ title: '', body: '' }),
    INPUTS_BLOCKED_REASON: '',
    INPUTS_BLOCKED_BY: '[]',
    INPUTS_SUMMARY: 'ready',
    INPUTS_REPORT: JSON.stringify({ type: 'archon_artifact', run_id: 'run', path: 'triage.md' }),
  };
}

function runBun(script: string, values: Record<string, string>): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync([process.execPath, script], {
    env: env(values),
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

describe('caller-owned triage state labels', () => {
  test('keeps a neutral result unlabeled when the mapping is empty', () => {
    const result = runBun(triageScript, {
      ...triageVerdict(),
      INPUTS_STATE_LABELS: '{}',
      INPUTS_PUBLISH: 'false',
    });
    expect(result.exitCode, result.stderr?.toString()).toBe(0);
    expect(JSON.parse(stdout(result))).toMatchObject({ labels: ['area-ui'], published: false });
  });

  test("keeps the pack's own state and size labels when no mapping is given", () => {
    const result = runBun(triageScript, {
      ...triageVerdict(),
      INPUTS_STATE_LABELS: '',
      INPUTS_PUBLISH: 'false',
    });
    expect(result.exitCode, result.stderr?.toString()).toBe(0);
    expect(JSON.parse(stdout(result))).toMatchObject({
      labels: ['archon-ready', 'archon-small', 'area-ui'],
    });
  });

  test('publishes the mapped state, preserves unrelated labels, and removes only mapped states', async () => {
    const artifacts = await mkdtemp(join(root, 'triage-'));
    const statePath = join(artifacts, 'state.json');
    const log = join(artifacts, 'gh.jsonl');
    await writeFile(
      statePath,
      JSON.stringify({
        labels: ['Area-UI', 'Team-Blocked', 'archon-noise'],
        available: ['Area-UI', 'Team-Blocked', 'Team-Ready'],
        comments: [],
      })
    );
    const result = runBun(triageScript, {
      ...triageVerdict(),
      INPUTS_STATE_LABELS: JSON.stringify({ READY: 'team-ready', BLOCKED: 'team-blocked' }),
      INPUTS_PUBLISH: 'true',
      GH_STATE: statePath,
      GH_LOG: log,
    });
    expect(result.exitCode, result.stderr?.toString()).toBe(0);
    // Applied labels take the repository's spelling, since the tracker matches by case.
    expect(JSON.parse(stdout(result))).toMatchObject({
      labels: ['Area-UI', 'Team-Ready'],
      published: true,
      skipped_labels: [],
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
    // Both mapped labels already exist in the repository, so none is created.
    expect(calls.some(call => call.args[0] === 'label' && call.args[1] === 'create')).toBe(false);
    const removals = calls.flatMap(call =>
      call.args.flatMap((value, index) =>
        call.args[index - 1] === '--remove-label' ? [value] : []
      )
    );
    expect(removals).toEqual(['Team-Blocked']);
  });

  test('a wait on open pull requests labels nothing; any other blocker still publishes BLOCKED', async () => {
    const blocked = (blockedBy: string[]) => ({
      ...triageVerdict([]),
      INPUTS_CONTRACT: 'BLOCKED',
      INPUTS_ROUTE: 'no_action',
      INPUTS_BLOCKED_REASON: 'waits on another change',
      INPUTS_BLOCKED_BY: JSON.stringify(blockedBy),
      INPUTS_STATE_LABELS: JSON.stringify({ READY: 'team-ready', BLOCKED: 'team-blocked' }),
      INPUTS_PUBLISH: 'true',
    });
    const run = async (blockedBy: string[]) => {
      const artifacts = await mkdtemp(join(root, 'triage-blocked-'));
      const statePath = join(artifacts, 'state.json');
      await writeFile(
        statePath,
        JSON.stringify({ labels: [], available: ['Team-Blocked', 'Team-Ready'], comments: [] })
      );
      const result = runBun(triageScript, {
        ...blocked(blockedBy),
        GH_STATE: statePath,
        GH_LOG: join(artifacts, 'gh.jsonl'),
      });
      expect(result.exitCode, result.stderr?.toString()).toBe(0);
      return {
        out: JSON.parse(stdout(result)) as Record<string, unknown>,
        labels: (JSON.parse(await readFile(statePath, 'utf8')) as { labels: string[] }).labels,
      };
    };

    // Seen live: BLOCKED on an open sibling PR left the issue skipped after it merged.
    const onPrs = await run([
      'https://github.com/owner/repo/pull/64',
      'https://github.com/owner/repo/pull/65/',
    ]);
    expect(onPrs.out).toMatchObject({ contract: 'BLOCKED', published: false });
    expect(onPrs.labels).toEqual([]);

    for (const blockers of [
      ['https://github.com/owner/repo/issues/9'],
      ['https://github.com/owner/repo/pull/64', 'https://github.com/owner/repo/issues/9'],
      [],
    ]) {
      const other = await run(blockers);
      expect(other.out).toMatchObject({ contract: 'BLOCKED', published: true });
      expect(other.labels).toEqual(['Team-Blocked']);
    }
  });

  test('rejects proposed labels that differ only by case', () => {
    const result = runBun(triageScript, {
      ...triageVerdict(['area-ui', 'Area-UI']),
      INPUTS_STATE_LABELS: '{}',
      INPUTS_PUBLISH: 'false',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr?.toString()).toContain('labels must not contain duplicates');
  });

  test('rejects ambiguous and malformed mappings before publication', async () => {
    const artifacts = await mkdtemp(join(root, 'triage-'));
    const log = join(artifacts, 'gh.jsonl');
    for (const mapping of [{ READY: 'same', BLOCKED: 'SAME' }, { UNKNOWN: 'label' }, []]) {
      const result = runBun(triageScript, {
        ...triageVerdict(),
        INPUTS_STATE_LABELS: JSON.stringify(mapping),
        INPUTS_PUBLISH: 'true',
        GH_LOG: log,
      });
      expect(result.exitCode).toBe(1);
    }
    // Refused before any read or write reached the tracker.
    expect(await Bun.file(log).exists()).toBe(false);
  });
});

describe('ship outcome', () => {
  test('names a negative contract verdict other than NO_ACTION in the advisory report', async () => {
    const artifacts = await mkdtemp(join(root, 'ship-'));
    const outcome = (contract: string): { delivered: boolean; summary: string } => {
      const result = runBun(shipOutcomeScript, {
        ARTIFACTS_DIR: artifacts,
        INPUTS_ROUTE: 'no_action',
        INPUTS_SUMMARY: 'stub summary',
        INPUTS_CONTRACT: contract,
        INPUTS_DELIVERED: 'null',
      });
      expect(result.exitCode, result.stderr?.toString()).toBe(0);
      return JSON.parse(stdout(result)) as { delivered: boolean; summary: string };
    };
    expect(outcome('BLOCKED')).toMatchObject({ delivered: false });
    expect(outcome('BLOCKED').summary).toStartWith('No delivery needed [BLOCKED]: stub summary');
    expect(outcome('NEEDS_CONTRACT_WORK').summary).toStartWith(
      'No delivery needed [NEEDS_CONTRACT_WORK]: stub summary'
    );
    expect(outcome('NO_ACTION').summary).toStartWith('No delivery needed: stub summary');
  });
});

describe('lifecycle intake state ownership', () => {
  test('uses the same state key domain as triage publication', async () => {
    // The triage vocabulary is a TypeScript object literal: its top-level keys.
    const source = await readFile(triageScript, 'utf8');
    const block = /const STATE_LABEL_METADATA[^=]*=\s*\{([\s\S]*?)\n\};/.exec(source)?.[1];
    expect(block, 'triage declares STATE_LABEL_METADATA').toBeDefined();
    const publicationStates = [...(block ?? '').matchAll(/^\s{2}([A-Z_]+):/gm)]
      .map(match => match[1])
      .sort();
    const program = `import ast,json,sys\nfrom pathlib import Path\nnode=next(n for n in ast.parse(Path(sys.argv[1]).read_text()).body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id==sys.argv[2] for t in n.targets))\nvalues=[k.value for k in (node.value.keys if isinstance(node.value,ast.Dict) else node.value.elts)]\nprint(json.dumps(sorted(values)))`;
    const result = Bun.spawnSync(
      ['uv', 'run', '--no-project', 'python', '-c', program, intakeScript, 'STATES'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const intakeStates = JSON.parse(stdout(result)) as string[];
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

describe('lifecycle intake dependencies and claims', () => {
  const labels = {
    READY: 'team-ready',
    DESIGN_FIRST: 'team-design',
    NEEDS_CONTRACT_WORK: 'team-contract',
    BLOCKED: 'team-blocked',
    NO_ACTION: 'team-closed',
  };
  const issue = (number: number, body = '', names: string[] = []) => ({
    number,
    url: `https://github.com/owner/repo/issues/${number}`,
    labels: names.map(name => ({ name })),
    body,
  });
  const intake = (issues: unknown[], prs: unknown[] = []) => {
    const result = runPython(intakeScript, {
      INPUTS_TARGET: '',
      INPUTS_STATE_LABELS: JSON.stringify(labels),
      GH_ISSUES: JSON.stringify(issues),
      GH_PRS: JSON.stringify(prs),
    });
    expect(result.exitCode, result.stderr?.toString()).toBe(0);
    return JSON.parse(stdout(result)) as Record<string, unknown>;
  };

  test('skips an issue while a dependency is open and picks it once it closes', () => {
    // #1 is held by its own open PR, so #2 (which depends on it) must wait.
    const held = intake(
      [issue(1), issue(2, 'Build on the skeleton.\n\nDepends on: #1')],
      [{ number: 9, title: 'Skeleton', body: 'Closes #1' }]
    );
    expect(held).toMatchObject({ found: false, waiting_on: [1] });
    expect(held.reason).toContain('stalled behind open dependencies #1');
    // A chain reports the root it is stuck behind, not every open link.
    expect(
      intake(
        [
          issue(1),
          issue(2, 'Depends on: #1'),
          issue(3, 'Depends on: #2'),
          issue(4, 'Depends on: #3'),
        ],
        [{ number: 9, title: 'Root', body: 'Closes #1' }]
      )
    ).toMatchObject({ found: false, waiting_on: [1] });

    expect(intake([issue(2, 'Depends on: #1'), issue(3)])).toMatchObject({
      target: 'https://github.com/owner/repo/issues/2',
      waiting_on: [],
    });
    // Several dependency lines: one still open keeps the issue waiting.
    expect(
      intake([issue(4, 'Depends on: #1\nDepends on: #3'), issue(3, '', ['team-ready'])])
    ).toMatchObject({ found: false, waiting_on: [3] });
  });

  test('only a closing keyword or Relates to claims an issue', () => {
    expect(
      intake([issue(1), issue(2)], [{ number: 9, title: 'Refactor', body: 'Follow-up to #1' }])
    ).toMatchObject({ target: 'https://github.com/owner/repo/issues/1' });
    for (const body of ['Closes #1', 'fixes: #1', 'Resolved #1', 'Relates to #1']) {
      expect(intake([issue(1), issue(2)], [{ number: 9, title: 'x', body }])).toMatchObject({
        target: 'https://github.com/owner/repo/issues/2',
      });
    }
  });

  test('re-evaluates a BLOCKED issue once every declared dependency is closed', () => {
    expect(intake([issue(5, 'Depends on: #1', ['Team-Blocked']), issue(6)])).toMatchObject({
      target: 'https://github.com/owner/repo/issues/5',
    });
    // Blocked on something intake cannot see (no declared dependency): stays touched.
    expect(
      intake([issue(5, 'Needs a vendor decision.', ['team-blocked']), issue(6)])
    ).toMatchObject({
      target: 'https://github.com/owner/repo/issues/6',
    });
    // Any other state label keeps it touched even with closed dependencies.
    expect(
      intake([issue(5, 'Depends on: #1', ['team-blocked', 'team-ready']), issue(6)])
    ).toMatchObject({ target: 'https://github.com/owner/repo/issues/6' });
  });

  test('reads dependency and claim references for this repository only', () => {
    const cases: Record<'dependencies' | 'claims', Array<[string, number[]]>> = {
      dependencies: [
        ['Depends on: #3', [3]],
        ['depends on: #3, #4', [3, 4]],
        ['DEPENDS ON: #3 and #12', [3, 12]],
        ['Depends on: owner/repo#7', [7]],
        ['Depends on: Owner/Repo#7', [7]],
        ['Depends on: other/repo#7', []],
        ['Depends on: https://github.com/owner/repo/issues/8', [8]],
        ['Depends on: https://github.com/owner/repo/pull/9', [9]],
        ['Depends on: https://github.com/other/repo/issues/8', []],
        ['Depends on: #3 (see other/repo#4)', [3]],
        ['We depend on: #3 in prose', []],
        ['Text mentions #5\nDepends on: #6', [6]],
        ['  Depends on: #2\r\nmore', [2]],
        ['Depends on: ##3', []],
        ['Depends on: #3abc', []],
        ['', []],
      ],
      claims: [
        ['Closes #1', [1]],
        ['closes: #1', [1]],
        ['Fixes #2, fixes #3', [2, 3]],
        ['Resolved #4.', [4]],
        ['Relates to #5', [5]],
        ['Follow-up to #6', []],
        ['See #7', []],
        ['Closes other/repo#8', []],
        ['Closes owner/repo#8', [8]],
        ['Fixes https://github.com/owner/repo/issues/9', [9]],
        ['Fixes https://github.com/other/repo/issues/9', []],
        ['prefixes #10', []],
        ['Closes #11 and #12', [11]],
      ],
    };
    const program = [
      'import importlib.util, json, sys',
      'spec = importlib.util.spec_from_file_location("intake", sys.argv[1])',
      'intake = importlib.util.module_from_spec(spec); spec.loader.exec_module(intake)',
      'cases = json.loads(sys.argv[2])',
      'print(json.dumps({',
      '  "dependencies": [sorted(intake.dependencies(t, "owner/repo")) for t, _ in cases["dependencies"]],',
      '  "claims": [sorted(intake.references(t, "owner/repo", intake.CLAIM_KEYWORD)) for t, _ in cases["claims"]],',
      '}))',
    ].join('\n');
    const result = Bun.spawnSync(
      ['uv', 'run', '--no-project', 'python', '-c', program, intakeScript, JSON.stringify(cases)],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    expect(result.exitCode, result.stderr?.toString()).toBe(0);
    const actual = JSON.parse(stdout(result)) as Record<string, number[][]>;
    expect(actual.dependencies).toEqual(cases.dependencies.map(([, want]) => want));
    expect(actual.claims).toEqual(cases.claims.map(([, want]) => want));
  });

  test('a dependency or claim naming another repository does not affect this one', () => {
    expect(
      intake(
        [issue(1), issue(2, 'Depends on: other/repo#1')],
        [{ number: 9, title: 'x', body: 'Closes other/repo#1' }]
      )
    ).toMatchObject({ target: 'https://github.com/owner/repo/issues/1', waiting_on: [] });
  });

  test('a dependency cycle reports both issues as waiting instead of picking either', () => {
    expect(intake([issue(1, 'Depends on: #2'), issue(2, 'Depends on: #1')])).toMatchObject({
      found: false,
      waiting_on: [1, 2],
    });
  });

  test('an open pull request named as a dependency keeps the issue waiting', () => {
    expect(
      intake([issue(3, 'Depends on: #9'), issue(4)], [{ number: 9, title: 'x', body: '' }])
    ).toMatchObject({ target: 'https://github.com/owner/repo/issues/4', waiting_on: [9] });
  });

  test('picks the oldest issue from beyond the first hundred, in any listing order', () => {
    // gh lists newest first; the old script asked for 100 and took the lowest of those.
    const many = Array.from({ length: 150 }, (_, index) => issue(150 - index));
    expect(intake(many)).toMatchObject({ target: 'https://github.com/owner/repo/issues/1' });
  });
});

describe('lifecycle closes the issue it worked after a confirmed merge', () => {
  const pr = 'https://github.com/owner/repo/pull/9';
  const close = async (
    target: string,
    values: Record<string, string> = {}
  ): Promise<{ output: Record<string, unknown>; calls: string[][] }> => {
    const log = join(root, `close-${crypto.randomUUID()}.jsonl`);
    await writeFile(log, '');
    const result = runPython(closeTargetScript, {
      INPUTS_TARGET: target,
      INPUTS_PRS: JSON.stringify([pr]),
      GH_PR_STATES: JSON.stringify({ [pr]: 'MERGED' }),
      GH_LOG: log,
      ...values,
    });
    expect(result.exitCode, result.stderr?.toString()).toBe(0);
    const calls = (await readFile(log, 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => (JSON.parse(line) as { args: string[] }).args);
    return { output: JSON.parse(stdout(result)) as Record<string, unknown>, calls };
  };
  const closes = (calls: string[][]): string[][] =>
    calls.filter(args => args[0] === 'issue' && args[1] === 'close');

  test('closes an open issue once its Relates-to pull request merged', async () => {
    const { output, calls } = await close('https://github.com/owner/repo/issues/4');
    expect(output).toMatchObject({ closed: true });
    expect(closes(calls)).toHaveLength(1);
    expect(closes(calls)[0]?.slice(0, 5)).toEqual(['issue', 'close', '4', '--repo', 'owner/repo']);
    expect(closes(calls)[0]?.join(' ')).toContain(pr);
  });

  test('accepts the short reference forms a caller may pass as the target', async () => {
    for (const [target, issue] of [
      ['#4', ['4']],
      ['4', ['4']],
      ['owner/repo#4', ['4', '--repo', 'owner/repo']],
    ] as const) {
      const { output, calls } = await close(target);
      expect(output).toMatchObject({ closed: true });
      expect(closes(calls)[0]?.slice(2, 2 + issue.length)).toEqual([...issue]);
    }
  });

  test('never closes the issue while any delivered pull request is unmerged', async () => {
    const other = 'https://github.com/owner/repo/pull/10';
    const { output, calls } = await close('https://github.com/owner/repo/issues/4', {
      INPUTS_PRS: JSON.stringify([pr, other]),
      GH_PR_STATES: JSON.stringify({ [pr]: 'MERGED', [other]: 'OPEN' }),
    });
    expect(output).toMatchObject({ closed: false });
    expect(output.reason).toContain(other);
    expect(closes(calls)).toHaveLength(0);
  });

  test('leaves an already closed issue alone', async () => {
    const { output, calls } = await close('https://github.com/owner/repo/issues/4', {
      GH_ISSUE_STATE: 'CLOSED',
    });
    expect(output).toMatchObject({ closed: false, reason: 'issue is already closed' });
    expect(closes(calls)).toHaveLength(0);
  });

  test('a work order, a pull request target or no delivery closes nothing', async () => {
    for (const target of ['Add a CSV export to the reports page', pr]) {
      const { output, calls } = await close(target);
      expect(output).toMatchObject({ closed: false, reason: 'target is not an issue reference' });
      expect(calls).toHaveLength(0);
    }
    const none = await close('#4', { INPUTS_PRS: '[]' });
    expect(none.output).toMatchObject({ closed: false });
    expect(none.calls).toHaveLength(0);
  });
});

describe('lifecycle binds the delivered pull request from facts', () => {
  const url = 'https://github.com/owner/repo/pull/9';
  let repo: string;
  let artifacts: string;
  let head: string;

  const git = (...args: string[]): string => {
    const out = Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
    if (out.exitCode !== 0) throw new Error(out.stderr.toString());
    return out.stdout.toString().trim();
  };

  beforeAll(async () => {
    repo = join(root, 'bind-repo');
    artifacts = join(root, 'bind-artifacts');
    await mkdir(join(artifacts, 'review'), { recursive: true });
    await mkdir(repo);
    git('init', '-q', '-b', 'main');
    git(
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'one'
    );
    git('checkout', '-q', '-b', 'archon/task-9');
    head = git('rev-parse', 'HEAD');
    await writeFile(join(artifacts, 'review', 'report.md'), 'ready');
    await writeFile(join(artifacts, 'validation.md'), 'green');
  });

  const bind = (delivery: unknown, view: Record<string, unknown> = {}, dir?: string) => {
    const result = runPython(
      bindScript,
      {
        INPUTS_DELIVERY: JSON.stringify(delivery),
        ARTIFACTS_DIR: dir ?? artifacts,
        GH_PR_VIEW: JSON.stringify({
          state: 'OPEN',
          isDraft: false,
          isCrossRepository: false,
          headRefName: 'archon/task-9',
          headRefOid: head,
          ...view,
        }),
      },
      repo
    );
    expect(result.exitCode, result.stderr?.toString()).toBe(0);
    return JSON.parse(stdout(result)) as Record<string, unknown>;
  };

  test("binds ship's certified pull request at this checkout's head", () => {
    expect(bind({ delivered: true, summary: `${url} plus caveats` })).toMatchObject({
      delivered: true,
      prs: [url],
      head,
    });
  });

  test("accepts a repair delivery's pr_url", () => {
    expect(bind({ pr_url: url })).toMatchObject({ delivered: true, prs: [url], head });
  });

  test('a declined or empty delivery binds nothing', () => {
    expect(bind({ delivered: false, summary: 'No delivery needed' })).toMatchObject({
      delivered: false,
      prs: [],
    });
    expect(bind({ delivered: true, summary: 'shipped, trust me' })).toMatchObject({
      delivered: false,
    });
  });

  test('a pull request that does not match this checkout is not delivered', () => {
    for (const view of [
      { headRefOid: 'f'.repeat(40) },
      { headRefName: 'someone-else' },
      { isDraft: true },
      { state: 'CLOSED' },
      { isCrossRepository: true },
    ]) {
      expect(bind({ delivered: true, summary: url }, view)).toMatchObject({
        delivered: false,
        prs: [],
      });
    }
  });

  test('missing review or validation reports from this run are not delivery', async () => {
    const empty = join(root, 'bind-empty-artifacts');
    await mkdir(empty, { recursive: true });
    expect(bind({ delivered: true, summary: url }, {}, empty)).toMatchObject({
      delivered: false,
    });
  });
});

describe('merge refresh reads the facts for the next planned merge', () => {
  const plan = {
    repository: 'owner/repo',
    base: 'main',
    base_sha: 'base1',
    method: 'squash',
    pull_requests: [
      { number: 7, url: 'https://github.com/owner/repo/pull/7', head_sha: 'h7' },
      { number: 8, url: 'https://github.com/owner/repo/pull/8', head_sha: 'h8' },
    ],
    evidence: [],
    reasons: [],
  };
  let artifacts: string;

  beforeAll(async () => {
    artifacts = join(root, 'refresh-artifacts');
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, 'merge-plan.json'), JSON.stringify(plan));
  });

  const refresh = (
    view: Record<string, unknown>,
    values: Record<string, string> = {}
  ): Record<string, unknown> => {
    const result = runPython(refreshScript, {
      ARTIFACTS_DIR: artifacts,
      INPUTS_PREVIOUS: '',
      GH_BASE_SHA: 'base1',
      REFRESH_UNKNOWN_WAIT_S: '0',
      GH_PR_VIEW: JSON.stringify({
        state: 'OPEN',
        isDraft: false,
        isCrossRepository: false,
        baseRefName: 'main',
        headRefOid: 'h7',
        mergeStateStatus: 'CLEAN',
        ...view,
      }),
      ...values,
    });
    expect(result.exitCode, result.stderr?.toString()).toBe(0);
    return JSON.parse(stdout(result)) as Record<string, unknown>;
  };

  test('authorizes the first planned merge while nothing moved', () => {
    expect(refresh({})).toEqual(
      expect.objectContaining({
        authorized: true,
        repository: 'owner/repo',
        number: 7,
        head_sha: 'h7',
        method: 'squash',
      })
    );
  });

  test('holds when the base, the head or mergeability changed', () => {
    expect(refresh({}, { GH_BASE_SHA: 'moved' })).toMatchObject({ authorized: false });
    expect(refresh({ headRefOid: 'other' })).toMatchObject({ authorized: false });
    expect(refresh({ baseRefName: 'develop' })).toMatchObject({ authorized: false });
    for (const status of ['DIRTY', 'BEHIND', 'DRAFT']) {
      expect(refresh({ mergeStateStatus: status })).toMatchObject({ authorized: false });
    }
    expect(refresh({ isDraft: true })).toMatchObject({ authorized: false });
    expect(refresh({ isCrossRepository: true })).toMatchObject({ authorized: false });
    expect(refresh({ state: 'MERGED' })).toMatchObject({ authorized: false });
  });

  test("re-reads GitHub's lazily computed mergeability before deciding", async () => {
    const seq = join(root, 'merge-seq.json');
    await writeFile(seq, JSON.stringify(['UNKNOWN', 'UNKNOWN', 'CLEAN']));
    expect(refresh({}, { GH_MERGE_SEQ_FILE: seq })).toMatchObject({ authorized: true });
    await writeFile(seq, JSON.stringify(['UNKNOWN']));
    expect(refresh({}, { GH_MERGE_SEQ_FILE: seq, REFRESH_UNKNOWN_READS: '2' })).toMatchObject({
      authorized: false,
    });
  });

  test('after a merge, the next pull request must already contain the new base', () => {
    const previous = JSON.stringify({
      urls: ['https://github.com/owner/repo/pull/7'],
      prior_base_sha: 'base2',
    });
    const next = { headRefOid: 'h8' };
    const values = { INPUTS_PREVIOUS: previous, GH_BASE_SHA: 'base2' };
    expect(refresh(next, { ...values, GH_BEHIND_BY: '1' })).toMatchObject({ authorized: false });
    expect(refresh(next, { ...values, GH_BEHIND_BY: '0' })).toMatchObject({
      authorized: true,
      number: 8,
      head_sha: 'h8',
    });
    // The base moved again since our own merge: hold.
    expect(refresh(next, { ...values, GH_BASE_SHA: 'base3' })).toMatchObject({
      authorized: false,
    });
  });

  test('a merge plan written with a UTF-8 byte order mark still reads', async () => {
    const bomArtifacts = join(root, 'refresh-bom-artifacts');
    await mkdir(bomArtifacts, { recursive: true });
    await writeFile(join(bomArtifacts, 'merge-plan.json'), '﻿' + JSON.stringify(plan));
    expect(refresh({}, { ARTIFACTS_DIR: bomArtifacts })).toMatchObject({
      authorized: true,
      number: 7,
    });
  });

  test('nothing is authorized once every planned pull request merged', () => {
    const previous = JSON.stringify({
      urls: plan.pull_requests.map(entry => entry.url),
      prior_base_sha: 'base3',
    });
    expect(refresh({}, { INPUTS_PREVIOUS: previous })).toMatchObject({ authorized: false });
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

describe('merge hold is a claim the shared review settles', () => {
  test('review scope reads the exact marker the merge queue publishes', async () => {
    const holds = await readFile(holdsScript, 'utf8');
    const marker = /const marker = '([^']+)';/.exec(holds)?.[1];
    expect(marker).toBe('<!-- archon-merge-hold -->');
    const scope = await readFile(
      join(workflowRoot, 'review', 'commands', 'review-scope.md'),
      'utf8'
    );
    expect(scope).toContain(`first line is \`${String(marker)}\``);
    expect(scope).toContain('**Merge hold**');
    // The queue writes `Held at <sha>:` and reasons as bullets; a cleared hold says so.
    expect(holds).toContain('Held at');
    expect(holds).toContain('Hold cleared at');
    expect(scope).toContain('Held at <sha>:');
    expect(scope).toContain('cleared carries no claim');
  });

  test('review synthesis settles each held reason as a merge-queue finding', async () => {
    const synthesize = await readFile(
      join(workflowRoot, 'review', 'commands', 'review-synthesize.md'),
      'utf8'
    );
    expect(synthesize).toContain('A **Merge hold** section in scope.md');
    expect(synthesize).toContain('`sources: [merge-queue]`');
    expect(synthesize).toContain('a merge-hold finding, which carries `merge-queue`');
  });
});

describe('pull request publication from a synthetic review branch', () => {
  async function publishFrom(
    head: string,
    prefix = ''
  ): Promise<{
    result: ReturnType<typeof Bun.spawnSync>;
    calls: string;
  }> {
    const artifacts = await mkdtemp(join(root, 'publish-pr-'));
    const intent = join(artifacts, 'pr-intent.json');
    const body = join(artifacts, 'pr-body.md');
    const log = join(artifacts, 'gh.jsonl');
    await writeFile(body, 'A body\n');
    await writeFile(
      intent,
      prefix +
        JSON.stringify({
          repo: { host: 'github.com', path: 'owner/repo' },
          head,
          headRevision: 'deadbeef',
          base: 'dev',
          title: 'A title',
          bodyPath: body,
          draft: true,
        })
    );
    const result = Bun.spawnSync([process.execPath, publishPrScript], {
      env: env({ INPUTS_INTENT: intent, ARCHON_SDLC_FORGE: 'gh', GH_LOG: log }),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const calls = (await Bun.file(log).exists()) ? await readFile(log, 'utf8') : '';
    return { result, calls };
  }

  for (const head of ['pr-12-review', 'archon/pr-12-review']) {
    test(`refuses to open a substitute pull request from ${head}`, async () => {
      const { result, calls } = await publishFrom(head);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr?.toString()).toContain('synthetic review branch');
      // Refused before any forge read or write.
      expect(calls).toBe('');
    });
  }

  test('the preparing prompt treats the branch name as the pull request it stands in for', async () => {
    const prompt = await readFile(join(workflowRoot, 'pr', 'commands', 'pr.md'), 'utf8');
    expect(prompt).toContain(
      'A current branch named `pr-<number>-review`, optionally prefixed `archon/`'
    );
    expect(prompt).toContain('never open a pull request from it');
  });

  test('an ordinary branch still reaches the forge lookup', async () => {
    const { result, calls } = await publishFrom('feature/pr-12-review-notes');
    expect(result.stderr?.toString()).not.toContain('synthetic review branch');
    expect(calls).toContain('"list"');
  });

  test('an intent written with a UTF-8 byte order mark still publishes', async () => {
    // PowerShell's ConvertTo-Json | Set-Content writes a BOM; a live run failed on it.
    const { result, calls } = await publishFrom('feature/notes', '﻿');
    expect(result.stderr?.toString()).not.toContain('JSON Parse error');
    expect(calls).toContain('"list"');
  });

  test('a hand-written intent with single-backslash Windows paths creates from the contract body', async () => {
    // The live shape: an agent wrote bodyPath as C:\Users\...\north-star-godot\...\pr-body.md
    // by hand. JSON reads \U as an invalid escape (the run failed) and \n as a newline.
    const artifacts = await mkdtemp(join(root, 'publish-pr-win-'));
    const intent = join(artifacts, 'pr-intent.json');
    const body = join(artifacts, 'pr-body.md');
    const log = join(artifacts, 'gh.jsonl');
    await writeFile(body, 'A body\n');
    await writeFile(
      intent,
      String.raw`{"repo":{"host":"github.com","path":"owner/repo"},"head":"feature/notes","headRevision":"deadbeef","base":"dev","title":"A \"quoted\" title","bodyPath":"C:\Users\someone\.archon\workspaces\owner\north-star\artifacts\runs\abc/pr-body.md","draft":true}`
    );
    const result = Bun.spawnSync([process.execPath, publishPrScript], {
      env: env({ INPUTS_INTENT: intent, ARCHON_SDLC_FORGE: 'gh', GH_LOG: log }),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.stderr?.toString()).not.toContain('JSON Parse error');
    const calls = (await readFile(log, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(line => (JSON.parse(line) as { args: string[] }).args);
    const create = calls.find(args => args[0] === 'pr' && args[1] === 'create');
    expect(create).toBeDefined();
    // The body comes from the path the contract fixes, beside the intent; valid
    // escapes in the agent's other strings keep their meaning.
    expect(create?.[create.indexOf('--body-file') + 1]).toBe(body);
    expect(create?.[create.indexOf('--title') + 1]).toBe('A "quoted" title');
  });
});

describe('agent-written JSON', () => {
  const load = async () =>
    (await import(join(workflowRoot, '.shared', 'agent-json.ts'))) as {
      parseAgentJson: (raw: string) => unknown;
    };

  test('strict JSON, a byte-order mark, and invalid escapes all parse; valid escapes keep their meaning', async () => {
    const { parseAgentJson } = await load();
    expect(parseAgentJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseAgentJson('﻿{"a":1}')).toEqual({ a: 1 });
    expect(parseAgentJson(String.raw`{"p":"C:\Users\x\.cache"}`)).toEqual({
      p: String.raw`C:\Users\x\.cache`,
    });
    expect(
      parseAgentJson(String.raw`{"q":"say \"hi\"","b":"a\\b","u":"\u00e9","p":"D:\work"}`)
    ).toEqual({
      q: 'say "hi"',
      b: String.raw`a\b`,
      u: 'é',
      p: String.raw`D:\work`,
    });
    // Once strict parsing has failed, \r \n \t \b \f are path characters, not controls.
    expect(parseAgentJson(String.raw`{"p":"C:\Users\me\review\new\tmp\bin\file.md"}`)).toEqual({
      p: String.raw`C:\Users\me\review\new\tmp\bin\file.md`,
    });
    // \u followed by non-hex is an invalid escape too.
    expect(parseAgentJson(String.raw`{"p":"C:\users\me"}`)).toEqual({ p: String.raw`C:\users\me` });
  });

  test('JSON that is broken for another reason still fails with the strict error', async () => {
    const { parseAgentJson } = await load();
    expect(() => parseAgentJson('{"a":')).toThrow();
    expect(() => parseAgentJson(String.raw`{"p":"C:\Users"`)).toThrow();
  });
});

describe('backlog acceptance criteria a delivery can satisfy', () => {
  test('the slicer never asks for files attached to the pull request', async () => {
    // Seen live: "a harness screenshot is attached" sent a correct delivery to replan,
    // because no workflow node can upload an image to a pull request.
    const prompt = await readFile(
      join(workflowRoot, 'backlog', 'commands', 'slice-backlog.md'),
      'utf8'
    );
    expect(prompt).toContain('Every criterion must be one the delivery itself can satisfy');
    expect(prompt).toContain('evidence file saved in the run');
    expect(prompt).toContain('Never require attaching files or images to the pull');
    expect(prompt).toContain('never require a human action');
  });
});
