import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import {
  configuredEvidence,
  discoveredEvidence,
  githubRepository,
  issueBody,
  issueMarker,
  object,
  publish,
  readDiagnosis,
  recordingScope,
  referenceVerifier,
  route,
  runCommand,
  settle,
  type CommandResult,
  type Diagnosis,
  type Evidence,
  type IssueReference,
  type Prepared,
  type PublicCase,
  type Receipt,
  type RunCommand,
  type VerifyReference,
} from '../scripts/regress.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempTree));
});
async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'archon-regress-test-'));
  roots.push(root);
  return root;
}
const context: Prepared = {
  revision: 'a'.repeat(40),
  base: 'release/testing',
  base_revision: 'b'.repeat(40),
  scope: 'client',
  ready: true,
  mode: 'configured',
  reason: '',
  started: 0,
  directory: '/artifacts/regress',
  profile_hash: '',
  checkout: '/checkout',
  recording_directory: '',
  validation_scope: '',
  probe: false,
};
const discoveredContext: Prepared = {
  ...context,
  mode: 'discovered',
  recording_directory: '/artifacts/regress/recordings-1',
  validation_scope: 'The parser package.',
};
/** A configured profile whose operator authorized a public probe of a non-clean full gate. */
const probeContext: Prepared = {
  ...context,
  probe: true,
  recording_directory: '/artifacts/regress/recordings-1',
  validation_scope: 'The public developer smoke check.',
};
const publicCase: PublicCase = {
  id: 'empty-input',
  root_cause_key: 'parser/empty-input',
  title: 'Empty input raises instead of returning a result',
  root_cause: 'The parser indexes the first element before checking length.',
  expected: 'Empty input returns an empty result.',
  actual: 'Empty input throws an exception.',
  reproduction: 'Run the repository empty-input parser test.',
  evidence: ['src/parser.ts:12 reads the first item'],
};
const execution: CommandResult = { exitCode: 1, stdout: 'private evaluator details', stderr: '' };
function report(status = 'product', extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...context, status, public_cases: [publicCase], ...extra });
}
function evidence(): Evidence {
  return configuredEvidence(context, execution, report(), '/artifacts/evidence.json');
}

/** The absent form of a publication proof, as the declared schema expresses it. */
const unproven = {
  root_cause_key: '',
  executions: [],
  test: { path: '', start: 0, end: 0 },
  cause: { path: '', start: 0, end: 0 },
  completed_product_assertion: false,
};
const proven = {
  root_cause_key: 'src/parser.ts/empty-input',
  executions: ['gate-1'],
  test: { path: 'tests/parser.test.ts', start: 10, end: 14 },
  cause: { path: 'src/parser.ts', start: 12, end: 12 },
  completed_product_assertion: true,
};
// Wire shapes first: every typed value a consumer sees is what readDiagnosis makes of the
// object the model actually returns, so the two can never drift apart in this file.
const diagnosis = readDiagnosis({
  status: 'defects',
  summary: 'One proven parser defect.',
  findings: [
    {
      public_case_id: publicCase.id,
      public_proof: unproven,
      title: 'PRIVATE MODEL TITLE',
      root_cause: 'PRIVATE MODEL CAUSE',
      expected: 'expected',
      actual: 'actual',
      reproduction: 'PRIVATE MODEL COMMAND',
      evidence: ['PRIVATE MODEL LOG'],
    },
  ],
});
const discoveredDiagnosis = readDiagnosis({
  status: 'defects',
  summary: 'One parser defect proven by the repository itself.',
  findings: [
    {
      public_case_id: '',
      public_proof: proven,
      title: 'Empty input raises instead of returning a result',
      root_cause: 'The parser indexes the first element before checking length.',
      expected: 'Empty input returns an empty result.',
      actual: 'Empty input throws an exception.',
      reproduction: 'Run the parser test suite.',
      evidence: ['tests/parser.test.ts asserts an empty result'],
    },
  ],
});
const clean: Diagnosis = { status: 'clean', summary: 'Checks passed.', findings: [] };

function receipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    revision: context.revision,
    base: context.base,
    base_revision: context.base_revision,
    scope: context.scope,
    id: 'gate-1',
    argv: ['bun', 'run', 'test'],
    checkout: context.checkout,
    intact: true,
    exit_code: 1,
    ...overrides,
  };
}
const PRIVATE_REPORT = 'bun run test: exit 1 at /checkout PRIVATE LOCAL DETAIL';
function discovered(
  verdict: unknown = { green: false, red_cause: 'inherited' },
  executions: Receipt[] = [receipt()]
): Evidence {
  return discoveredEvidence(
    discoveredContext,
    verdict,
    PRIVATE_REPORT,
    '/artifacts/regress/validation.md',
    executions,
    'discovered'
  );
}
/** What a public probe collects: archon-validate's own artifact, over the probe's receipts. */
function probed(
  verdict: unknown = { green: false, red_cause: 'inherited' },
  executions: Receipt[] = [receipt()]
): Evidence {
  return discoveredEvidence(
    probeContext,
    verdict,
    'public smoke check: exit 1',
    '/artifacts/regress/validation.md',
    executions,
    'public-probe'
  );
}
const verifies: VerifyReference = async () => true;
const rejects: VerifyReference = async () => false;

test('a real command timeout cannot certify a product assertion', async () => {
  const result = await runCommand([process.execPath, '-e', 'setTimeout(() => {}, 10000)'], {
    timeout: 50,
  });
  expect(result.exitCode).toBeNull();
  expect(configuredEvidence(context, result, report(), 'evidence').status).toBe('inconclusive');
});

describe('evidence and judgment boundary', () => {
  test('collects a clean configured check and a reproducible product failure', () => {
    expect(
      configuredEvidence(context, { ...execution, exitCode: 0 }, report('clean'), 'evidence').status
    ).toBe('clean');
    expect(evidence().status).toBe('product');
    expect(settle(evidence(), diagnosis, true, true)).toEqual(diagnosis);
  });
  test.each(['missing tool', 'startup failed', 'browser missing'])(
    '%s without check evidence is inconclusive',
    () => {
      expect(configuredEvidence(context, execution, '', 'evidence').status).toBe('inconclusive');
      expect(
        configuredEvidence(context, execution, report('inconclusive'), 'evidence').status
      ).toBe('inconclusive');
    }
  );
  test('rejects timeouts, green/nonzero, product/zero, and mismatched revision, scope or base', () => {
    for (const exitCode of [null, 0])
      expect(
        configuredEvidence(context, { ...execution, exitCode }, report(), 'evidence').status
      ).toBe('inconclusive');
    expect(configuredEvidence(context, execution, report('clean'), 'evidence').status).toBe(
      'inconclusive'
    );
    for (const key of ['revision', 'scope', 'base', 'base_revision']) {
      expect(
        configuredEvidence(
          context,
          execution,
          report('product', { [key]: 'different' }),
          'evidence'
        ).status
      ).toBe('inconclusive');
    }
  });
  test('ordinary validation requires an actual artifact even when the model claims green', () => {
    expect(
      discoveredEvidence(
        discoveredContext,
        { green: true, red_cause: '' },
        '',
        'report',
        [receipt({ exit_code: 0 })],
        'discovered'
      ).status
    ).toBe('inconclusive');
    expect(discovered({ green: true, red_cause: '' }, [receipt({ exit_code: 0 })]).status).toBe(
      'clean'
    );
    for (const red_cause of ['environment', ''])
      expect(discovered({ green: false, red_cause }).status).toBe('inconclusive');
    expect(discovered().status).toBe('product');
  });
  test('ordinary validation without execution receipts proves nothing, green or red', () => {
    const unrecorded = discovered({ green: true, red_cause: '' }, []);
    expect(unrecorded.status).toBe('inconclusive');
    expect(unrecorded.reason).toContain('recorded no command execution');
    expect(discovered({ green: false, red_cause: 'introduced' }, []).status).toBe('inconclusive');
  });
  test('a receipt from another revision, base, scope, or a dirtied checkout is not evidence', () => {
    for (const overrides of [
      { revision: 'c'.repeat(40) },
      { base: 'other' },
      { base_revision: 'd'.repeat(40) },
      { scope: 'server' },
      { checkout: '/elsewhere' },
      { intact: false },
    ]) {
      const result = discovered({ green: false, red_cause: 'inherited' }, [receipt(overrides)]);
      expect(result.status).toBe('inconclusive');
      expect(result.reason).toContain('bound');
    }
  });
  test('an interrupted command neither certifies green nor completes a product failure', () => {
    expect(
      discovered({ green: true, red_cause: '' }, [
        receipt({ exit_code: 0 }),
        receipt({ id: 'gate-2', exit_code: null }),
      ]).status
    ).toBe('inconclusive');
    expect(discovered({ green: false, red_cause: 'introduced' }, [receipt({ exit_code: null })]).status).toBe(
      'inconclusive'
    );
  });
  test('unrooted investigation, missing report, and contradictory diagnosis cannot yield defects', () => {
    expect(settle(evidence(), diagnosis, false, true).status).toBe('inconclusive');
    expect(settle(evidence(), diagnosis, true, false).status).toBe('inconclusive');
    expect(settle({ ...evidence(), status: 'inconclusive' }, diagnosis, true, true).status).toBe(
      'inconclusive'
    );
    expect(settle(evidence(), clean, true, true).status).toBe('inconclusive');
    expect(() => readDiagnosis({ ...diagnosis, findings: [] })).toThrow();
  });
  test('rejects duplicate public root identity and malformed public evidence', () => {
    expect(
      configuredEvidence(
        context,
        execution,
        report('product', { public_cases: [publicCase, publicCase] }),
        'evidence'
      ).status
    ).toBe('inconclusive');
    expect(
      configuredEvidence(
        context,
        execution,
        report('product', { public_cases: [{ ...publicCase, evidence: [] }] }),
        'evidence'
      ).status
    ).toBe('inconclusive');
  });
  test('a malformed publication proof is refused rather than quietly downgraded', () => {
    const finding = { ...discoveredDiagnosis.findings[0] };
    for (const broken of [
      { ...proven, root_cause_key: 'Parser/Empty Input' },
      { ...proven, executions: [] },
      { ...proven, test: { path: '../outside/parser.ts', start: 1, end: 2 } },
      { ...proven, test: { path: '/abs/parser.ts', start: 1, end: 2 } },
      { ...proven, cause: { path: 'src/parser.ts', start: 12, end: 4 } },
      { ...proven, cause: { path: 'src/parser.ts', start: 0, end: 4 } },
      { ...proven, completed_product_assertion: 'yes' },
    ]) {
      expect(() =>
        readDiagnosis({
          ...discoveredDiagnosis,
          findings: [{ ...finding, public_proof: broken }],
        })
      ).toThrow();
    }
  });
});

function fakeGithub(
  options: {
    known?: PublicCase;
    failQuery?: boolean;
    failReadback?: boolean;
    wrongReadback?: boolean;
    failCreate?: boolean;
    canonicalCase?: boolean;
  } = {}
): {
  run: RunCommand;
  calls: string[][];
  bodies: string[];
} {
  const calls: string[][] = [];
  const bodies: string[] = [];
  let body = issueBody('owner/repo', options.known ?? publicCase, context.revision);
  const row = (): Record<string, unknown> => ({
    number: 7,
    html_url: options.canonicalCase
      ? 'https://github.com/Owner/Repo/issues/7'
      : 'https://github.com/owner/repo/issues/7',
    body,
  });
  const run: RunCommand = async (argv, input) => {
    calls.push(argv);
    if (argv.includes('--paginate'))
      return options.failQuery
        ? { exitCode: 1, stdout: '', stderr: 'private auth failure' }
        : {
            exitCode: 0,
            stdout: JSON.stringify([[], options.known ? [row()] : []]),
            stderr: '',
          };
    if (argv.includes('POST')) {
      if (options.failCreate)
        return { exitCode: 1, stdout: '', stderr: 'ambiguous connection loss' };
      const payload = JSON.parse(input?.stdin ?? '{}');
      body = payload.body;
      bodies.push(input?.stdin ?? '');
      return { exitCode: 0, stdout: JSON.stringify(row()), stderr: '' };
    }
    return options.failReadback
      ? { exitCode: 1, stdout: '', stderr: 'readback unavailable' }
      : {
          exitCode: 0,
          stdout: JSON.stringify({ ...row(), ...(options.wrongReadback ? { body: 'wrong' } : {}) }),
          stderr: '',
        };
  };
  return { run, calls, bodies };
}
const record = async (): Promise<void> => {};
/** The trusted-profile publication request; each test varies the one field it is about. */
function request(overrides: Partial<Parameters<typeof publish>[0]> = {}): Parameters<
  typeof publish
>[0] {
  return {
    evidence: evidence(),
    diagnosis,
    authorized: true,
    repository: 'owner/repo',
    record,
    verify: verifies,
    localPaths: [context.checkout, context.directory],
    ...overrides,
  };
}
function discoveredRequest(
  overrides: Partial<Parameters<typeof publish>[0]> = {}
): Parameters<typeof publish>[0] {
  return request({ evidence: discovered(), diagnosis: discoveredDiagnosis, ...overrides });
}

describe('deterministic GitHub publication', () => {
  test('clean and publish=false never call GitHub', async () => {
    const gh = fakeGithub();
    expect((await publish(request({ authorized: false, run: gh.run }))).publication).toBe(
      'disabled'
    );
    expect((await publish(request({ diagnosis: clean, run: gh.run }))).publication).toBe(
      'not-applicable'
    );
    expect(gh.calls).toHaveLength(0);
  });
  test('inconclusive evidence and invented public ids cannot authorize publication', async () => {
    const gh = fakeGithub();
    expect(
      (
        await publish(
          request({ evidence: { ...evidence(), status: 'inconclusive' }, run: gh.run })
        )
      ).publication
    ).toBe('blocked');
    expect(
      (
        await publish(
          request({
            diagnosis: {
              ...diagnosis,
              findings: [{ ...diagnosis.findings[0], public_case_id: 'invented' }],
            },
            run: gh.run,
          })
        )
      ).publication
    ).toBe('blocked');
    expect(gh.calls).toHaveLength(0);
  });
  test('creates and reads back an issue using only trusted public fields', async () => {
    const gh = fakeGithub();
    const snapshots: unknown[] = [];
    const result = await publish(
      request({
        record: async (issues: IssueReference[]) => {
          snapshots.push(structuredClone(issues));
        },
        run: gh.run,
        lockRoot: await temporary(),
      })
    );
    expect(result.publication).toBe('published');
    expect(result.issues[0]).toMatchObject({ number: 7, disposition: 'created', verified: true });
    expect(gh.calls).toHaveLength(3);
    expect(gh.bodies[0]).toContain(publicCase.root_cause);
    expect(gh.bodies[0]).not.toContain('PRIVATE');
    expect(gh.bodies[0]).not.toContain('private evaluator');
    expect(snapshots).toHaveLength(2);
  });
  test('known issues in any state are reused without a create, across revisions and scopes', async () => {
    const gh = fakeGithub({ known: publicCase, canonicalCase: true });
    const result = await publish(
      request({
        evidence: { ...evidence(), revision: 'c'.repeat(40), scope: 'another' },
        run: gh.run,
        lockRoot: await temporary(),
      })
    );
    expect(result.issues[0]).toMatchObject({ disposition: 'existing', verified: true });
    expect(result.issues[0].url).toBe('https://github.com/Owner/Repo/issues/7');
    expect(gh.calls.some(argv => argv.includes('POST'))).toBe(false);
    expect(issueMarker('OWNER/REPO', publicCase.root_cause_key)).toBe(
      issueMarker('owner/repo', publicCase.root_cause_key)
    );
  });
  test('malformed successful query responses never authorize a create', async () => {
    for (const stdout of ['not JSON', JSON.stringify([[{ message: 'unclassified failure' }]])]) {
      const calls: string[][] = [];
      const result = await publish(
        request({
          run: async argv => {
            calls.push(argv);
            return { exitCode: 0, stdout, stderr: '' };
          },
          lockRoot: await temporary(),
        })
      );
      expect(result.publication).toBe('blocked');
      expect(calls).toHaveLength(1);
    }
  });
  test('query failure never becomes no matches and ambiguous creation is never retried', async () => {
    for (const options of [{ failQuery: true }, { failCreate: true }]) {
      const gh = fakeGithub(options);
      const result = await publish(request({ run: gh.run, lockRoot: await temporary() }));
      expect(result.publication).toBe('blocked');
      expect(gh.calls.filter(argv => argv.includes('POST'))).toHaveLength(
        options.failQuery ? 0 : 1
      );
      expect(JSON.stringify(result)).not.toContain('private auth');
    }
  });
  test.each([{ failReadback: true }, { wrongReadback: true }])(
    'preserves created references on failed readback %j',
    async options => {
      const gh = fakeGithub(options);
      const result = await publish(request({ run: gh.run, lockRoot: await temporary() }));
      expect(result.publication).toBe('blocked');
      expect(result.issues[0]).toMatchObject({
        number: 7,
        verified: false,
        disposition: 'created',
      });
    }
  );
  test('a second local publisher stops while the first holds the repository lock', async () => {
    const root = await temporary();
    const gh = fakeGithub();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(r => {
      entered = r;
    });
    const wait = new Promise<void>(r => {
      release = r;
    });
    const first = publish(
      request({
        run: async (argv, input) => {
          if (argv.includes('--paginate')) {
            entered();
            await wait;
          }
          return gh.run(argv, input);
        },
        lockRoot: root,
      })
    );
    await started;
    const second = await publish(request({ run: gh.run, lockRoot: root }));
    expect(second.publication).toBe('blocked');
    expect(second.publication_reason).toContain('lock');
    release();
    expect((await first).publication).toBe('published');
  });
  test('normalizes GitHub remotes without exposing credentials and refuses other forges', () => {
    expect(githubRepository('https://secret@github.com/Owner/Repo.git')).toBe('owner/repo');
    expect(githubRepository('git@github.com:Owner/Repo.git')).toBe('owner/repo');
    expect(githubRepository('ssh://git@github.com/Owner/Repo.git')).toBe('owner/repo');
    expect(githubRepository('https://elsewhere.invalid/owner/repo')).toBeNull();
  });
});

describe('publication from ordinary discovery', () => {
  test('publishes one grounded public failure without any private validation detail', async () => {
    const gh = fakeGithub();
    const result = await publish(discoveredRequest({ run: gh.run, lockRoot: await temporary() }));
    expect(result.publication).toBe('published');
    expect(result.issues[0]).toMatchObject({
      key: proven.root_cause_key,
      disposition: 'created',
      verified: true,
    });
    const body = gh.bodies[0];
    expect(body).toContain('The parser indexes the first element before checking length.');
    expect(body).toContain('tests/parser.test.ts:10-14');
    expect(body).toContain('src/parser.ts:12-12');
    expect(body).toContain(context.revision);
    expect(body).not.toContain('PRIVATE LOCAL DETAIL');
    expect(body).not.toContain('/artifacts/regress/validation.md');
    expect(body).not.toContain('/checkout');
    expect(body).not.toContain(discoveredContext.recording_directory);
  });
  test('a repeat run over the same cause reuses its issue instead of filing another', async () => {
    const published = fakeGithub();
    await publish(discoveredRequest({ run: published.run, lockRoot: await temporary() }));
    const filed = JSON.parse(published.bodies[0]).body as string;
    const repeat = fakeGithub({
      known: {
        ...publicCase,
        id: proven.root_cause_key,
        root_cause_key: proven.root_cause_key,
      },
    });
    const result = await publish(
      discoveredRequest({
        // A later revision and a narrower scope: cause identity, not the run, owns dedup.
        evidence: { ...discovered(), revision: 'c'.repeat(40), scope: 'parser' },
        run: repeat.run,
        lockRoot: await temporary(),
      })
    );
    expect(result.issues[0]).toMatchObject({ disposition: 'existing', verified: true });
    expect(repeat.calls.some(argv => argv.includes('POST'))).toBe(false);
    expect(filed).toContain(issueMarker('owner/repo', proven.root_cause_key));
  });
  test('a proof without a recorded completed failure never reaches GitHub', async () => {
    const cases: {
      label: string;
      request: Parameters<typeof publish>[0];
      reason?: string;
    }[] = [
      {
        label: 'no receipts collected at all',
        request: discoveredRequest({
          evidence: discovered({ green: false, red_cause: 'inherited' }, []),
        }),
        reason: 'product-red evidence',
      },
      {
        label: 'a cited receipt this run never recorded',
        request: discoveredRequest({
          evidence: { ...discovered(), executions: [receipt({ id: 'other-gate' })] },
        }),
      },
      {
        label: 'every cited command succeeded',
        request: discoveredRequest({
          evidence: { ...discovered(), executions: [receipt({ exit_code: 0 })] },
        }),
      },
      {
        label: 'the cited command never completed',
        request: discoveredRequest({
          evidence: { ...discovered(), executions: [receipt({ exit_code: null })] },
        }),
      },
      {
        label: 'the model did not assert a completed product failure',
        request: discoveredRequest({
          diagnosis: readDiagnosis({
            ...discoveredDiagnosis,
            findings: [
              {
                ...discoveredDiagnosis.findings[0],
                public_proof: { ...proven, completed_product_assertion: false },
              },
            ],
          }),
        }),
      },
      {
        label: 'the cited source is not tracked at the checked revision',
        request: discoveredRequest({ verify: rejects }),
      },
      {
        label: 'the finding carries no publishable proof',
        request: discoveredRequest({
          diagnosis: readDiagnosis({
            ...discoveredDiagnosis,
            findings: [{ ...discoveredDiagnosis.findings[0], public_proof: unproven }],
          }),
        }),
      },
    ];
    for (const { label, request: pending, reason } of cases) {
      const gh = fakeGithub();
      const result = await publish({ ...pending, run: gh.run });
      expect(`${label}: ${result.publication}`).toBe(`${label}: blocked`);
      expect(`${label}: ${result.publication_reason}`).toContain(reason ?? 'verified public proof');
      expect(gh.calls).toHaveLength(0);
    }
  });
  test('two findings sharing one cause identity cannot both be filed', async () => {
    const gh = fakeGithub();
    const result = await publish(
      discoveredRequest({
        diagnosis: readDiagnosis({
          ...discoveredDiagnosis,
          findings: [discoveredDiagnosis.findings[0], discoveredDiagnosis.findings[0]],
        }),
        run: gh.run,
      })
    );
    expect(result.publication).toBe('blocked');
    expect(gh.calls).toHaveLength(0);
  });
  test('public evidence carrying a local path is refused before any request', async () => {
    const gh = fakeGithub();
    const result = await publish(
      discoveredRequest({
        diagnosis: readDiagnosis({
          ...discoveredDiagnosis,
          findings: [
            {
              ...discoveredDiagnosis.findings[0],
              evidence: ['/checkout/src/parser.ts:12 reads the first item'],
            },
          ],
        }),
        run: gh.run,
      })
    );
    expect(result.publication).toBe('blocked');
    expect(result.publication_reason).toContain('local checkout');
    expect(gh.calls).toHaveLength(0);
  });
  test('an unsupported forge is reported after the evidence is judged, never guessed at', async () => {
    const result = await publish(discoveredRequest({ repository: null }));
    expect(result.publication_reason).toContain('github.com origin');
  });
});

describe('public probe of a configured full gate', () => {
  const cleanGate = configuredEvidence(
    context,
    { ...execution, exitCode: 0 },
    report('clean'),
    '/artifacts/evidence.json'
  );
  test('a probe runs only for an authorized operator scope over a non-clean full gate', () => {
    expect(route(discoveredContext, null)).toEqual({
      validate: true,
      scope: discoveredContext.validation_scope,
    });
    expect(route({ ...discoveredContext, ready: false }, null)).toEqual({
      validate: false,
      scope: '',
    });
    // No public_probe_scope: a configured profile keeps its strict single-gate shape.
    expect(route(context, evidence())).toEqual({ validate: false, scope: '' });
    const probing = { validate: true, scope: probeContext.validation_scope };
    expect(route(probeContext, evidence())).toEqual(probing);
    expect(route(probeContext, { ...evidence(), status: 'inconclusive' })).toEqual(probing);
    expect(route(probeContext, cleanGate)).toEqual({ validate: false, scope: '' });
    expect(route(probeContext, { status: 'product' })).toEqual({ validate: false, scope: '' });
  });
  test('the probe scope carries the operator public check and the recorder, not the gate scope', () => {
    const scope = recordingScope(
      'Run the public developer smoke check.',
      '/artifacts/regress/recordings-1/record.ts'
    );
    expect(scope).toContain('Run the public developer smoke check.');
    expect(scope).toContain('--record');
    expect(scope).not.toContain(context.scope);
  });
  test('probe evidence keeps the discovery proof requirements and carries no trusted case', () => {
    expect(probed().status).toBe('product');
    expect(probed().source).toBe('public-probe');
    expect(probed().public_cases).toEqual([]);
    expect(probed({ green: false, red_cause: 'environment' }).status).toBe('inconclusive');
    expect(probed({ green: false, red_cause: 'inherited' }, []).status).toBe('inconclusive');
  });
  test('a probe publishes its own verified proof, never a configured check trusted case', async () => {
    const gh = fakeGithub();
    const result = await publish(
      discoveredRequest({ evidence: probed(), run: gh.run, lockRoot: await temporary() })
    );
    expect(result.publication).toBe('published');
    expect(result.issues[0]).toMatchObject({ key: proven.root_cause_key, disposition: 'created' });
    expect(gh.bodies[0]).not.toContain('private evaluator');
    // Trusted cases belong to the configured route. Source alone decides which proof a
    // finding needs, so a case smuggled onto probe evidence still cannot be published.
    const smuggled = fakeGithub();
    const blocked = await publish(
      discoveredRequest({
        evidence: { ...probed(), public_cases: [publicCase] },
        diagnosis,
        run: smuggled.run,
      })
    );
    expect(blocked.publication).toBe('blocked');
    expect(blocked.publication_reason).toContain('verified public proof');
    expect(smuggled.calls).toHaveLength(0);
  });
});

const script = resolve(import.meta.dir, '../scripts/regress.ts');
async function node(
  cwd: string,
  artifacts: string,
  inputs: Record<string, unknown>,
  base = 'release/testing'
): Promise<Record<string, unknown>> {
  const child = Bun.spawn([process.execPath, script], {
    cwd,
    env: {
      ...process.env,
      DATABASE_URL: '',
      ARTIFACTS_DIR: artifacts,
      BASE_BRANCH: base,
      ...Object.fromEntries(
        Object.entries(inputs).map(([key, value]) => [
          `INPUTS_${key.toUpperCase()}`,
          typeof value === 'string' ? value : JSON.stringify(value),
        ])
      ),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe('');
  expect(code).toBe(0);
  return JSON.parse(stdout);
}
async function checkout(): Promise<{ cwd: string; artifacts: string; root: string }> {
  const root = await temporary();
  const cwd = join(root, 'checkout');
  const artifacts = join(root, 'artifacts');
  await mkdir(cwd);
  await mkdir(artifacts);
  for (const args of [
    ['init', '-b', 'release/testing'],
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    ],
  ]) {
    const child = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    expect(await child.exited).toBe(0);
  }
  return { cwd, artifacts, root };
}
async function git(cwd: string, args: string[]): Promise<void> {
  const child = Bun.spawn(
    ['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd, stdout: 'pipe', stderr: 'pipe' }
  );
  expect(await child.exited).toBe(0);
}
/** Run one command through the recorder the prepare node planted for the validate agent. */
async function recorded(
  prepared: Record<string, unknown>,
  argv: string[]
): Promise<{ code: number; stdout: string }> {
  const child = Bun.spawn(
    [
      process.execPath,
      join(String(prepared.recording_directory), 'record.ts'),
      '--record',
      ...argv,
    ],
    { cwd: tmpdir(), stdout: 'pipe', stderr: 'pipe' }
  );
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return { code, stdout };
}

test('real script nodes run a trusted check on a non-main base and collect revision-bound evidence', async () => {
  const { cwd, artifacts, root } = await checkout();
  const check = join(root, 'check.ts');
  await writeFile(
    check,
    `await Bun.write(process.env.REGRESS_EVIDENCE_PATH, JSON.stringify({
    revision: process.env.REGRESS_REVISION, base: process.env.REGRESS_BASE, base_revision: process.env.REGRESS_BASE_REVISION,
    scope: process.env.REGRESS_SCOPE, status: 'clean', public_cases: [] }));`
  );
  const policy = join(root, 'policy.json');
  await writeFile(
    policy,
    JSON.stringify({ version: 1, argv: [process.execPath, check], timeout_seconds: 30 })
  );
  const prepared = await node(cwd, artifacts, { phase: 'prepare', scope: 'parser', policy });
  expect(prepared.ready).toBe(true);
  expect(prepared.base).toBe('release/testing');
  expect(prepared.recording_directory).toBe('');
  const fixed = await node(cwd, artifacts, { phase: 'configured', prepared, policy });
  expect(fixed.status).toBe('clean');
  const collected = await node(cwd, artifacts, {
    phase: 'collect',
    prepared,
    fixed,
    validation: null,
  });
  const finished = await node(cwd, artifacts, {
    phase: 'finish',
    prepared,
    evidence: collected,
    diagnosis: clean,
    investigation: null,
    publish: false,
  });
  expect(finished.status).toBe('clean');
  expect(finished.publication).toBe('disabled');
  expect(JSON.parse(await readFile(join(artifacts, 'regress/result.json'), 'utf8'))).toEqual(
    finished
  );
});
test('real nodes reject checkout-local policy and missing tools without claiming a defect', async () => {
  const { cwd, artifacts, root } = await checkout();
  const policy = join(cwd, 'policy.json');
  const value = JSON.stringify({
    version: 1,
    argv: ['archon-regress-nonexistent-tool'],
    timeout_seconds: 1,
  });
  await writeFile(policy, value);
  const rejected = await node(cwd, artifacts, { phase: 'prepare', scope: '', policy });
  expect(rejected.ready).toBe(false);
  const external = join(root, 'external.json');
  await writeFile(external, value);
  const prepared = await node(cwd, artifacts, { phase: 'prepare', scope: '', policy: external });
  const fixed = await node(cwd, artifacts, { phase: 'configured', prepared, policy: external });
  expect(fixed.status).toBe('inconclusive');
});
test('real ordinary collector rejects absent, stale, and unrecorded validation', async () => {
  const { cwd, artifacts } = await checkout();
  const prepared = await node(cwd, artifacts, { phase: 'prepare', scope: '', policy: '' });
  expect(String(prepared.validation_scope)).toContain('--record');
  const validation = { green: true, red_cause: '', summary: 'Gate passed.' };
  const inputs = { phase: 'collect', prepared, validation, fixed: null };
  expect((await node(cwd, artifacts, inputs)).status).toBe('inconclusive');
  const report = join(artifacts, 'validation.md');
  await writeFile(report, 'project check: exit 0');
  await utimes(report, new Date(0), new Date(0));
  expect((await node(cwd, artifacts, inputs)).status).toBe('inconclusive');
  await writeFile(report, 'project check: exit 0');
  const unrecorded = await node(cwd, artifacts, inputs);
  expect(unrecorded.status).toBe('inconclusive');
  expect(String(unrecorded.reason)).toContain('recorded no command execution');
});
test('the real recorder streams a command, passes its status through, and receipts it', async () => {
  const { cwd, artifacts } = await checkout();
  const prepared = await node(cwd, artifacts, { phase: 'prepare', scope: '', policy: '' });
  const passed = await recorded(prepared, [
    process.execPath,
    '-e',
    'console.log("gate output"); process.exit(0)',
  ]);
  expect(passed.code).toBe(0);
  expect(passed.stdout).toContain('gate output');
  const failed = await recorded(prepared, [process.execPath, '-e', 'process.exit(3)']);
  expect(failed.code).toBe(3);
  await writeFile(join(artifacts, 'validation.md'), 'project gate: exit 3');
  const collected = await node(cwd, artifacts, {
    phase: 'collect',
    prepared,
    validation: { green: false, red_cause: 'inherited', summary: 'The gate failed.' },
    fixed: null,
  });
  expect(collected.status).toBe('product');
  const executions = collected.executions as Receipt[];
  expect(executions.map(row => row.exit_code).sort()).toEqual([0, 3]);
  expect(executions.every(row => row.intact && row.revision === collected.revision)).toBe(true);
  // No command output travels with a receipt, so evidence cannot carry a private stream.
  expect(Object.keys(executions[0]).sort()).toEqual([
    'argv',
    'base',
    'base_revision',
    'checkout',
    'exit_code',
    'id',
    'intact',
    'revision',
    'scope',
  ]);
});
test('a recorded command that edits tracked source invalidates its own evidence', async () => {
  const { cwd, artifacts } = await checkout();
  await writeFile(join(cwd, 'source.txt'), 'original\n');
  await git(cwd, ['add', 'source.txt']);
  await git(cwd, ['commit', '-m', 'source']);
  const prepared = await node(cwd, artifacts, { phase: 'prepare', scope: '', policy: '' });
  const mutation = await recorded(prepared, [
    process.execPath,
    '-e',
    'await Bun.write("source.txt", "rewritten\\n"); process.exit(1)',
  ]);
  expect(mutation.code).toBe(1);
  // The command tidied up after itself, so only its own receipt still knows.
  await writeFile(join(cwd, 'source.txt'), 'original\n');
  await writeFile(join(artifacts, 'validation.md'), 'project gate: exit 1');
  const collected = await node(cwd, artifacts, {
    phase: 'collect',
    prepared,
    validation: { green: false, red_cause: 'introduced', summary: 'The gate failed.' },
    fixed: null,
  });
  expect(collected.status).toBe('inconclusive');
  expect(String(collected.reason)).toContain('intact checkout');
});
test('real nodes publish an ordinary discovery only on a verified proof of the checked revision', async () => {
  const { cwd, artifacts } = await checkout();
  await mkdir(join(cwd, 'src'));
  await mkdir(join(cwd, 'tests'));
  await writeFile(join(cwd, 'src/parser.ts'), 'export function parse(items) {\n  return items[0];\n}\n');
  await writeFile(
    join(cwd, 'tests/parser.test.ts'),
    'test("empty input", () => {\n  expect(parse([])).toEqual([]);\n});\n'
  );
  await git(cwd, ['add', 'src/parser.ts', 'tests/parser.test.ts']);
  await git(cwd, ['commit', '-m', 'parser']);
  await git(cwd, ['remote', 'add', 'origin', 'https://elsewhere.invalid/owner/repo.git']);
  const prepared = await node(cwd, artifacts, { phase: 'prepare', scope: 'parser', policy: '' });
  const failure = await recorded(prepared, [process.execPath, '-e', 'process.exit(1)']);
  expect(failure.code).toBe(1);
  await writeFile(join(artifacts, 'validation.md'), 'parser test: exit 1');
  await writeFile(join(artifacts, 'investigation.md'), 'The parser reads before checking length.');
  const collected = await node(cwd, artifacts, {
    phase: 'collect',
    prepared,
    validation: { green: false, red_cause: 'inherited', summary: 'The parser test failed.' },
    fixed: null,
  });
  expect(collected.status).toBe('product');
  const recordedId = (collected.executions as Receipt[])[0].id;
  const finding = (proof: Record<string, unknown>): Record<string, unknown> => ({
    public_case_id: '',
    public_proof: proof,
    title: 'Empty input raises instead of returning a result',
    root_cause: 'The parser reads the first item before checking length.',
    expected: 'Empty input returns an empty result.',
    actual: 'Empty input throws an exception.',
    reproduction: 'Run the parser test suite.',
    evidence: ['tests/parser.test.ts asserts an empty result'],
  });
  const proof = {
    root_cause_key: 'src/parser.ts/empty-input',
    executions: [recordedId],
    test: { path: 'tests/parser.test.ts', start: 1, end: 3 },
    cause: { path: 'src/parser.ts', start: 2, end: 2 },
    completed_product_assertion: true,
  };
  const finish = async (proof: Record<string, unknown>): Promise<Record<string, unknown>> =>
    node(cwd, artifacts, {
      phase: 'finish',
      prepared,
      evidence: collected,
      diagnosis: {
        status: 'defects',
        summary: 'One proven parser defect.',
        findings: [finding(proof)],
      },
      investigation: { rooted: true, summary: 'Rooted in the parser.' },
      publish: true,
    });
  // The proof verifies against the real checkout, so the run reaches its destination check.
  const verified = await finish(proof);
  expect(verified.status).toBe('defects');
  expect(verified.publication).toBe('blocked');
  expect(String(verified.publication_reason)).toContain('github.com origin');
  for (const broken of [
    { ...proof, cause: { path: 'src/parser.ts', start: 400, end: 900 } },
    { ...proof, cause: { path: 'src/absent.ts', start: 1, end: 1 } },
    { ...proof, executions: ['00000000-0000-4000-8000-000000000000'] },
  ]) {
    const blocked = await finish(broken);
    expect(blocked.publication).toBe('blocked');
    expect(String(blocked.publication_reason)).toContain('verified public proof');
  }
  const local = await finish({ ...proof, root_cause_key: '' });
  expect(String(local.publication_reason)).toContain('verified public proof');
});
const CANARY = 'PRIVATE-EVALUATOR-CANARY';
/**
 * A configured profile whose full gate fails and whose report is private throughout: an
 * extra report field, its own console stream, and even its approved public case all carry
 * the canary, so anything the probe route lets through would show it.
 */
async function privateGate(root: string, status: string): Promise<string> {
  const check = join(root, 'check.ts');
  await writeFile(
    check,
    `await Bun.write(process.env.REGRESS_EVIDENCE_PATH, JSON.stringify({
    revision: process.env.REGRESS_REVISION, base: process.env.REGRESS_BASE, base_revision: process.env.REGRESS_BASE_REVISION,
    scope: process.env.REGRESS_SCOPE, status: ${JSON.stringify(status)},
    evaluator_notes: ${JSON.stringify(CANARY)},
    public_cases: [{ id: 'evaluator-case', root_cause_key: 'evaluator/case',
      title: ${JSON.stringify(CANARY)}, root_cause: ${JSON.stringify(CANARY)},
      expected: ${JSON.stringify(CANARY)}, actual: ${JSON.stringify(CANARY)},
      reproduction: ${JSON.stringify(CANARY)}, evidence: [${JSON.stringify(CANARY)}] }] }));
    console.log(${JSON.stringify(CANARY)});
    process.exit(${status === 'product' ? '1' : '0'});`
  );
  const policy = join(root, 'policy.json');
  await writeFile(
    policy,
    JSON.stringify({ version: 1, argv: [process.execPath, check], timeout_seconds: 30 })
  );
  return policy;
}
/** A committed defect the public probe can prove on its own, with a remote off github.com. */
async function parserRepository(cwd: string): Promise<void> {
  await mkdir(join(cwd, 'src'));
  await mkdir(join(cwd, 'tests'));
  await writeFile(join(cwd, 'src/parser.ts'), 'export function parse(items) {\n  return items[0];\n}\n');
  await writeFile(
    join(cwd, 'tests/parser.test.ts'),
    'test("empty input", () => {\n  expect(parse([])).toEqual([]);\n});\n'
  );
  await git(cwd, ['add', 'src/parser.ts', 'tests/parser.test.ts']);
  await git(cwd, ['commit', '-m', 'parser']);
  await git(cwd, ['remote', 'add', 'origin', 'https://elsewhere.invalid/owner/repo.git']);
}
const PROBE_SCOPE = 'Run the public developer smoke check.';

test('a red full gate lets an authorized public probe publish what it proves, and nothing private', async () => {
  const { cwd, artifacts, root } = await checkout();
  await parserRepository(cwd);
  const policy = await privateGate(root, 'product');
  const prepared = await node(cwd, artifacts, {
    phase: 'prepare',
    scope: 'client',
    policy,
    public_probe_scope: PROBE_SCOPE,
  });
  expect(prepared.probe).toBe(true);
  expect(String(prepared.validation_scope)).toContain(PROBE_SCOPE);
  const fixed = await node(cwd, artifacts, { phase: 'configured', prepared, policy });
  expect(fixed.status).toBe('product');
  // The private gate really did produce the canary in the material a strict operator publishes.
  expect(JSON.stringify(fixed)).toContain(CANARY);
  const routed = await node(cwd, artifacts, { phase: 'route', prepared, fixed });
  expect(routed).toEqual({ validate: true, scope: prepared.validation_scope });
  const failure = await recorded(prepared, [process.execPath, '-e', 'process.exit(1)']);
  expect(failure.code).toBe(1);
  await writeFile(join(artifacts, 'validation.md'), 'public smoke check: exit 1');
  await writeFile(join(artifacts, 'investigation.md'), 'The parser reads before checking length.');
  const collected = await node(cwd, artifacts, {
    phase: 'collect',
    prepared,
    fixed,
    validation: { green: false, red_cause: 'inherited', summary: 'The public smoke check failed.' },
  });
  expect(collected.status).toBe('product');
  expect(collected.source).toBe('public-probe');
  expect(collected.public_cases).toEqual([]);
  expect(collected.report).toBe(join(artifacts, 'regress', 'validation.md'));
  expect(JSON.stringify(collected)).not.toContain(CANARY);
  const finished = await node(cwd, artifacts, {
    phase: 'finish',
    prepared,
    evidence: collected,
    diagnosis: {
      status: 'defects',
      summary: 'One defect the public probe proves on its own.',
      findings: [
        {
          public_case_id: '',
          public_proof: {
            root_cause_key: 'src/parser.ts/empty-input',
            executions: [(collected.executions as Receipt[])[0].id],
            test: { path: 'tests/parser.test.ts', start: 1, end: 3 },
            cause: { path: 'src/parser.ts', start: 2, end: 2 },
            completed_product_assertion: true,
          },
          title: 'Empty input raises instead of returning a result',
          root_cause: 'The parser reads the first item before checking length.',
          expected: 'Empty input returns an empty result.',
          actual: 'Empty input throws an exception.',
          reproduction: 'Run the public developer smoke check.',
          evidence: ['tests/parser.test.ts asserts an empty result'],
        },
      ],
    },
    investigation: { rooted: true, summary: 'Rooted in the parser.' },
    publish: true,
  });
  // Every evidence gate passed; only the unsupported forge stops the request.
  expect(finished.status).toBe('defects');
  expect(String(finished.publication_reason)).toContain('github.com origin');
  expect(JSON.stringify(finished)).not.toContain(CANARY);
});
test('a green or missing public probe keeps the full gate refusal instead of reporting clean', async () => {
  const { cwd, artifacts, root } = await checkout();
  const policy = await privateGate(root, 'product');
  const prepared = await node(cwd, artifacts, {
    phase: 'prepare',
    scope: 'client',
    policy,
    public_probe_scope: PROBE_SCOPE,
  });
  const fixed = await node(cwd, artifacts, { phase: 'configured', prepared, policy });
  const collect = async (validation: unknown): Promise<Record<string, unknown>> =>
    node(cwd, artifacts, { phase: 'collect', prepared, fixed, validation });
  // The probe never produced an artifact.
  const unavailable = await collect(null);
  expect(unavailable.status).toBe('inconclusive');
  expect(String(unavailable.reason)).toContain('full gate was not clean');
  await recorded(prepared, [process.execPath, '-e', 'process.exit(0)']);
  await writeFile(join(artifacts, 'validation.md'), 'public smoke check: exit 0');
  const green = await collect({ green: true, red_cause: '', summary: 'The public check passed.' });
  expect(green.status).toBe('inconclusive');
  expect(String(green.reason)).toContain('full gate was not clean');
  expect(JSON.stringify(green)).not.toContain(CANARY);
});
test('without a public probe scope a configured profile keeps its strict single-gate behavior', async () => {
  const { cwd, artifacts, root } = await checkout();
  const policy = await privateGate(root, 'product');
  const prepared = await node(cwd, artifacts, { phase: 'prepare', scope: 'client', policy });
  expect(prepared.probe).toBe(false);
  expect(prepared.recording_directory).toBe('');
  const fixed = await node(cwd, artifacts, { phase: 'configured', prepared, policy });
  expect(await node(cwd, artifacts, { phase: 'route', prepared, fixed })).toEqual({
    validate: false,
    scope: '',
  });
  const collected = await node(cwd, artifacts, {
    phase: 'collect',
    prepared,
    fixed,
    validation: null,
  });
  expect(collected.status).toBe('product');
  expect(collected.source).toBe('configured');
  expect((collected.public_cases as PublicCase[])[0].root_cause_key).toBe('evaluator/case');
});
test('a clean full gate stays clean and never spends a public probe', async () => {
  const { cwd, artifacts, root } = await checkout();
  const policy = await privateGate(root, 'clean');
  const prepared = await node(cwd, artifacts, {
    phase: 'prepare',
    scope: 'client',
    policy,
    public_probe_scope: PROBE_SCOPE,
  });
  const fixed = await node(cwd, artifacts, { phase: 'configured', prepared, policy });
  expect(fixed.status).toBe('clean');
  expect(await node(cwd, artifacts, { phase: 'route', prepared, fixed })).toEqual({
    validate: false,
    scope: '',
  });
  const collected = await node(cwd, artifacts, {
    phase: 'collect',
    prepared,
    fixed,
    validation: null,
  });
  expect(collected.status).toBe('clean');
  expect(collected.source).toBe('configured');
});
test('the reference verifier reads the checked revision, not the working tree', async () => {
  const { cwd } = await checkout();
  await writeFile(join(cwd, 'source.txt'), 'one\ntwo\nthree\n');
  await git(cwd, ['add', 'source.txt']);
  await git(cwd, ['commit', '-m', 'source']);
  const head = Bun.spawn(['git', 'rev-parse', 'HEAD'], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const revision = (await new Response(head.stdout).text()).trim();
  const verify = referenceVerifier(cwd);
  expect(await verify({ path: 'source.txt', start: 1, end: 3 }, revision)).toBe(true);
  expect(await verify({ path: 'source.txt', start: 3, end: 4 }, revision)).toBe(false);
  expect(await verify({ path: 'absent.txt', start: 1, end: 1 }, revision)).toBe(false);
  expect(await verify({ path: 'source.txt', start: 1, end: 1 }, 'c'.repeat(40))).toBe(false);
  // Untracked working-tree content is not evidence about the revision under check.
  await writeFile(join(cwd, 'scratch.txt'), 'local only\n');
  expect(await verify({ path: 'scratch.txt', start: 1, end: 1 }, revision)).toBe(false);
});
test('an unresolved base retains the concrete preparation failure in the returned result', async () => {
  const { cwd, artifacts } = await checkout();
  const prepared = await node(
    cwd,
    artifacts,
    { phase: 'prepare', scope: '', policy: '' },
    'absent-base'
  );
  expect(prepared.ready).toBe(false);
  const collected = await node(cwd, artifacts, {
    phase: 'collect',
    prepared,
    validation: null,
    fixed: null,
  });
  const finished = await node(cwd, artifacts, {
    phase: 'finish',
    prepared,
    evidence: collected,
    diagnosis: { status: 'inconclusive', summary: 'Base unavailable', findings: [] },
    investigation: null,
    publish: true,
  });
  expect(finished.status).toBe('inconclusive');
  expect(finished.summary).toBe(prepared.reason);
  expect(finished.publication).toBe('not-applicable');
});
test('the final gate rejects evidence replaced after collection', async () => {
  const { cwd, artifacts } = await checkout();
  const prepared = await node(cwd, artifacts, { phase: 'prepare', scope: '', policy: '' });
  await recorded(prepared, [process.execPath, '-e', 'process.exit(0)']);
  await writeFile(join(artifacts, 'validation.md'), 'project check: exit 0');
  const collected = await node(cwd, artifacts, {
    phase: 'collect',
    prepared,
    validation: { green: true, red_cause: '', summary: 'Gate passed.' },
    fixed: null,
  });
  expect(collected.status).toBe('clean');
  await writeFile(String(collected.report), 'replaced evidence');
  const finished = await node(cwd, artifacts, {
    phase: 'finish',
    prepared,
    evidence: collected,
    diagnosis: clean,
    investigation: null,
    publish: true,
  });
  expect(finished.status).toBe('inconclusive');
  expect(finished.summary).toContain('changed before publication');
  expect(finished.publication).toBe('not-applicable');
});

test('diagnosis schema conforms to the typed consumer, including every status and finding field', async () => {
  const workflow = object(
    Bun.YAML.parse(await readFile(resolve(import.meta.dir, '../archon-regress.yaml'), 'utf8'))
  );
  const nodes = workflow.nodes;
  if (!Array.isArray(nodes)) throw new Error('Missing workflow nodes');
  const schema = object(
    object(nodes.find((value: unknown) => object(value).id === 'diagnose')).output_format
  );
  function conforms(value: unknown, format: unknown): void {
    const shape = object(format);
    if (Array.isArray(value)) {
      expect(shape.type).toBe('array');
      value.forEach((item: unknown) => conforms(item, shape.items));
    } else if (typeof value === 'object' && value !== null) {
      const properties = object(shape.properties);
      const fields = object(value);
      expect(shape.type).toBe('object');
      expect(Object.keys(properties).sort()).toEqual(Object.keys(fields).sort());
      expect(shape.required).toEqual(expect.arrayContaining(Object.keys(fields)));
      for (const [key, item] of Object.entries(fields)) conforms(item, properties[key]);
    } else expect(shape.type).toBe(typeof value);
  }
  const finding = {
    public_case_id: publicCase.id,
    public_proof: unproven,
    title: 'Title',
    root_cause: 'Cause',
    expected: 'Expected',
    actual: 'Actual',
    reproduction: 'Reproduction',
    evidence: ['src/parser.ts:12'],
  };
  const variants: Record<Diagnosis['status'], Record<string, unknown>> = {
    clean: { ...clean },
    defects: {
      status: 'defects',
      summary: 'One proven defect.',
      findings: [finding, { ...finding, public_case_id: '', public_proof: proven }],
    },
    inconclusive: { status: 'inconclusive', summary: 'Missing evidence', findings: [] },
  };
  expect(object(object(schema.properties).status).enum).toEqual(Object.keys(variants));
  for (const variant of Object.values(variants)) {
    conforms(variant, schema);
    const parsed = readDiagnosis(variant);
    expect(parsed.status).toBe(variant.status as Diagnosis['status']);
    expect(parsed.findings.map(row => row.public_proof)).toEqual(
      variant.status === 'defects' ? [null, proven] : []
    );
  }
});

test('CLI composes regress and binds the recording scope into the real validate block', async () => {
  const root = await temporary();
  const workflows = join(root, '.archon/workflows');
  await mkdir(workflows, { recursive: true });
  await writeFile(
    join(workflows, 'regress-composition.yaml'),
    `
name: regress-composition
description: Test the included regression contract without agents or publication.
returns: result
nodes:
  - id: regression
    include: archon-regress
    with: { scope: parser, policy: '', publish: false }
  - id: result
    script: |
      const result = JSON.parse(process.env.INPUTS_RESULT);
      if (result.status !== 'clean' || result.publication !== 'disabled') throw new Error('Unexpected included result');
      console.log(JSON.stringify(result));
    runtime: bun
    depends_on: [regression]
    with: { result: '$regression.output' }
`
  );
  const scope = recordingScope('parser', '/artifacts/regress/recordings-1/record.ts');
  const stubs = join(root, 'stubs.yaml');
  await writeFile(
    stubs,
    `
regression__prepare: { ready: true, mode: discovered }
regression__route: { validate: true, scope: ${JSON.stringify(scope)} }
regression__validation__validate: { green: true, red_cause: '', summary: 'Checks passed.' }
regression__collect: { status: clean }
regression__diagnose: { status: clean, summary: 'Checks passed.', findings: [] }
regression__finish: { status: clean, publication: disabled, issues: [] }
`
  );
  const cli = resolve(import.meta.dir, '../../../../../packages/cli/src/cli.ts');
  const child = Bun.spawn(
    [
      process.execPath,
      cli,
      'workflow',
      'run',
      'regress-composition',
      '--cwd',
      root,
      '--dry-run',
      '--exec-code',
      '--stubs',
      stubs,
      '--json',
    ],
    {
      env: { ...process.env, DATABASE_URL: '', ARCHON_HOME: join(root, 'home') },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`Composition failed: ${stdout}\n${stderr}`);
  const result = JSON.parse(stdout);
  expect(result.outcome).toBe('completed');
  const trace = result.trace as { nodeId: string; resolvedText?: string }[];
  const validate = trace.find(entry => entry.nodeId === 'regression__validation__validate');
  expect(validate?.resolvedText).toContain(scope);
});
