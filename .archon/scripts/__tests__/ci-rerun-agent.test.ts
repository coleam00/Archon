/**
 * Paid behavioral eval of the shipped CI command, using Archon's provider runner.
 * Run explicitly: ARCHON_TEST_CI_AGENT=1 bun run test .archon/scripts/__tests__/ci-rerun-agent.test.ts
 * Forge and report tools are in-memory; the agent has no shell or real forge access.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createProvider } from '@archon/providers/claude';
import { providerRegistry } from '@archon/providers';
import type { MessageChunk } from '@archon/providers';
import { forgeRequestSchema, forgeResponseSchema } from '../../../packages/forge/src/operations';
import { parseWorkflow } from '../../../packages/workflows/src/loader';
import { forgePrRecordSchema } from '../../../packages/forge/src/lifecycle';
import { forgePrRecord } from './deliver-checks-harness';

const track = trackTempRoots();
const pack = join(import.meta.dir, '../../workflows/sdlc/deliver');

for (const staleReads of [0, 1]) {
  test.skipIf(process.env.ARCHON_TEST_CI_AGENT !== '1')(
    `CI agent accepts a completed rerun after ${staleReads} stale state reads`,
    async () => {
      const cwd = track(mkdtempSync(join(tmpdir(), 'archon-ci-agent-')));
      const parsed = parseWorkflow(
        readFileSync(join(pack, 'archon-deliver-block.yaml'), 'utf8'),
        'archon-deliver-block.yaml',
        providerRegistry
      );
      const rounds = parsed.workflow?.nodes.find(node => node.id === 'rounds');
      if (!rounds || rounds.kind !== 'loop_group') throw new Error('deliver has no rounds');
      const ci = rounds.loop_group.nodes.find(node => node.id === 'ci');
      if (!ci || ci.kind !== 'agent' || !ci.output_format)
        throw new Error('deliver has no CI output schema');
      const pr = forgePrRecordSchema.parse(forgePrRecord({ is_draft: false }));
      const ref = { repo: pr.repo, number: pr.number };
      const failed = {
        unit: { kind: 'check', id: 'old-job', name: 'test' },
        rerun: { id: '100', attempt: 1 },
      };
      const completed = {
        ...failed,
        unit: { ...failed.unit, id: 'new-job' },
        rerun: { id: '100', attempt: 2 },
      };
      const calls: string[] = [];
      const reports = new Map<string, string>();
      let reruns = 0;
      let reads = 0;
      const abort = new AbortController();
      const budget = (name: string): void => {
        calls.push(name);
        if (calls.length > 8) {
          abort.abort();
          throw new Error(`CI agent exceeded 8 tool calls: ${calls.join(', ')}`);
        }
      };
      const command = readFileSync(join(pack, 'commands/ci.md'), 'utf8')
        .replaceAll('$INPUTS.pr', JSON.stringify(pr))
        .replaceAll('$INPUTS.source', 'forge')
        .replaceAll('$ARTIFACTS_DIR', '/artifacts');
      const prompt = `${command}

## Eval checkpoint

Continue this CI node from immediately before its single allowed rerun. Earlier in
this same node you verified checkout HEAD deadbeef, the PR's matching head, a clean
base merge, and ready state. You read all concluded checks at revision deadbeef:
${JSON.stringify(failed)} failed because its runner lost network connectivity
before executing any source file. The latest base run passed. The diff changes
only README.md. You judged this an infrastructure failure outside the PR and
eligible for one rerun; no rerun has been requested yet.

The fixture replaces only transport: use the forge tool for CLI forge operations,
passing their ordinary JSON --data object as data. It returns the ordinary CLI
response. Use write_report for artifact writes. All other observations above are
already complete; no shell, filesystem or real forge access is available. Highest
review round is 1. Pauses may be omitted in this in-memory fixture. Follow the CI
command and return its structured output.
`;
      let result: Extract<MessageChunk, { type: 'result' }> | undefined;
      for await (const chunk of createProvider().sendQuery(prompt, cwd, undefined, {
        model: 'sonnet',
        abortSignal: AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]),
        nodeConfig: { nodeId: 'ci', allowed_tools: [] },
        outputFormat: { type: 'json_schema', schema: ci.output_format },
        nativeTools: [
          {
            name: 'forge',
            description: 'Fixture transport for archon forge <op> --json --data <data>.',
            inputSchema: {
              properties: { op: { kind: 'string' }, data: { kind: 'string' } },
              required: ['op', 'data'],
            },
            handler: async args => {
              budget(String(args.op));
              const request = forgeRequestSchema.parse({
                ...JSON.parse(String(args.data)),
                operationId: 'eval',
                op: args.op,
              });
              let value: unknown;
              switch (request.op) {
                case 'checks.rerun':
                  expect(request).toMatchObject({ ref, revision: 'deadbeef', units: [failed] });
                  expect(++reruns).toBe(1);
                  value = {
                    outcome: 'applied',
                    changed: true,
                    target: ref,
                    ref,
                    revision: 'deadbeef',
                    units: [{ ...failed, rerun: completed.rerun }],
                  };
                  break;
                case 'checks.state': {
                  expect(request.ref).toEqual(ref);
                  if (reruns) reads++;
                  const green = reruns === 1 && reads > staleReads;
                  value = {
                    ref,
                    revision: 'deadbeef',
                    required: null,
                    approvalPending: false,
                    units: [
                      {
                        ...(green ? completed : failed),
                        nativeState: 'completed',
                        phase: 'completed',
                        nativeResult: green ? 'success' : 'failure',
                        result: green ? 'success' : 'failure',
                        state: green ? 'green' : 'red',
                      },
                    ],
                    summary: {
                      state: green ? 'green' : 'red',
                      counts: {
                        total: 1,
                        green: green ? 1 : 0,
                        red: green ? 0 : 1,
                        pending: 0,
                        gated: 0,
                        unknown: 0,
                      },
                    },
                  };
                  break;
                }
                case 'pr.view':
                  expect(request.selector).toEqual({ kind: 'number', ref });
                  value = { pr, title: 'Docs', body: '', author: null };
                  break;
                default:
                  throw new Error(`Unexpected forge operation: ${request.op}`);
              }
              return JSON.stringify(
                forgeResponseSchema.parse({
                  operationId: 'eval',
                  ok: true,
                  result: { op: request.op, value },
                })
              );
            },
          },
          {
            name: 'write_report',
            description: 'Write an artifact file (or copy it by writing the same content).',
            inputSchema: {
              properties: { path: { kind: 'string' }, content: { kind: 'string' } },
              required: ['path', 'content'],
            },
            handler: async args => {
              budget('write_report');
              reports.set(String(args.path), String(args.content));
              return 'written';
            },
          },
        ],
      })) {
        if (chunk.type === 'result') result = chunk;
      }
      expect(result?.isError).not.toBe(true);
      expect(result?.structuredOutput).toMatchObject({ state: 'green', rerun: 'green' });
      expect(reruns).toBe(1);
      expect(reads).toBe(staleReads + 1);
      expect(calls).toContain('pr.view');
      expect(calls).not.toContain('pr.draft');
      expect(calls.length).toBeLessThanOrEqual(8);
      expect(reports.has('/artifacts/ci.md')).toBe(true);
      const report = reports.get('/artifacts/ci.md');
      expect(report).toContain('deadbeef');
      expect(report).toContain('100');
      expect(report).toMatch(/attempt\D*2/i);
      expect(reports.get('/artifacts/ci-round-1.md')).toBe(reports.get('/artifacts/ci.md'));
    },
    150_000
  );
}
