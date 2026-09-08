/** Real proposal scripts and git, with simulated agent judgments and forge reads. */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { trackTempRoots } from '@archon/paths/test-utils';
import { workItemFixture } from '../../../forge/src/test/workitem-fixture';

export const discoveryPack = join(
  import.meta.dir,
  '../../../../.archon/workflows/sdlc/discoveries'
);
const track = trackTempRoots();
export async function discoveryPublicationFixture(
  update = false,
  overrides: Record<string, unknown> = {}
) {
  const root = track(await mkdtemp(join(tmpdir(), 'discovery publication ')));
  const target = { number: 42, url: 'https://github.com/example/repo/issues/42' };
  const input = {
    remote: 'https://github.com/example/repo.git',
    records: [
      {
        title: 'A source defect',
        claim: 'Source behavior needs correction',
        evidence: ['AGENTS.md:1'],
        source_node: 'review-code',
      },
    ],
    revalidation: [
      {
        item_index: 0,
        verdict: 'supported',
        evidence_refs: [{ path: 'AGENTS.md', line: 1 }],
        note: 'Simulated source judgment',
      },
    ],
    search: [{ item_index: 0, forge_checked: true, matches: update ? [target] : [] }],
    classification: [
      {
        item_index: 0,
        classification: update ? 'update-existing' : 'new',
        target_item: update ? target : null,
        public_title: 'Source defect',
        public_summary: 'Exact public text with `literal` and $(data).',
        rationale: 'Source supports correction.',
        disclosure_safe: true,
      },
    ],
    ...overrides,
  };
  const processResult = Bun.spawn(
    [
      process.platform === 'win32' ? 'python' : 'python3',
      join(import.meta.dir, '../defaults/discovery-proposals-harness.py'),
      root,
      join(discoveryPack, 'scripts'),
    ],
    {
      stdin: new Blob([JSON.stringify(input)]),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    }
  );
  const [code, stdout, stderr] = await Promise.all([
    processResult.exited,
    new Response(processResult.stdout).text(),
    new Response(processResult.stderr).text(),
  ]);
  if (code !== 0) throw new Error(stderr);
  const result = z
    .object({
      steps: z.array(
        z.object({ name: z.string(), code: z.number(), stdout: z.string(), stderr: z.string() })
      ),
    })
    .parse(JSON.parse(stdout));
  const transport = workItemFixture('example/repo');
  await writeFile(join(root, 'forge.json'), JSON.stringify({ hosts: {} }));
  const env = {
    ARTIFACTS_DIR: join(root, 'artifacts'),
    ARCHON_HOME: root,
    ARCHON_EXECUTABLE: process.execPath,
    ARCHON_EXECUTABLE_ARGS: JSON.stringify([
      join(import.meta.dir, '../../../cli/src/commands/fixtures/forge-public-cli.ts'),
      transport.server.url.origin,
    ]),
    GH_TOKEN: 'fixture-secret',
    GITHUB_TOKEN: '',
    ARCHON_TELEMETRY_DISABLED: '1',
  };
  const script = async (mode: string, inputs: Record<string, string> = {}) => {
    const child = Bun.spawn(
      [
        process.platform === 'win32' ? 'python' : 'python3',
        join(discoveryPack, 'scripts/publication.py'),
      ],
      {
        cwd: join(root, 'repo'),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, ...env, INPUTS_MODE: mode, ...inputs },
      }
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  return {
    root,
    repo: join(root, 'repo'),
    artifacts: env.ARTIFACTS_DIR,
    steps: result.steps,
    transport,
    env,
    script,
  };
}
