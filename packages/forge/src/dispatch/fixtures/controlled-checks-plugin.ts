import { readFileSync, writeFileSync } from 'node:fs';
import { checksVerdictFixture } from '../../conformance';
import {
  checksStateRequestSchema,
  publicRequestSchema,
  prRecordSchema,
  type ChecksState,
} from '../../schemas';
const [config, mode, op] = process.argv.slice(2);
const settings = JSON.parse(config) as {
  state: ChecksState;
  sha: string;
  required?: ChecksState;
  behavior?: 'malformed' | 'failure';
  marker?: string;
};
if (mode === 'metadata') {
  console.log(
    JSON.stringify({
      protocol: 1,
      name: 'checks-fixture',
      version: '1.0.0',
      forge: 'fixture',
      hosts: ['fixture.test'],
      capabilities: ['checks.state', 'pr.ready'],
      token_env: 'FIXTURE_TOKEN',
    })
  );
} else {
  const request: unknown = JSON.parse(readFileSync(0, 'utf8'));
  if (op === 'checks.state') {
    checksStateRequestSchema.parse(request);
    if (settings.behavior === 'failure') {
      console.log(JSON.stringify({ kind: 'forge_error', evidence: 'fixture read failed' }));
      process.exit(1);
    }
    if (settings.behavior === 'malformed') {
      console.log('malformed');
      process.exit(0);
    }
    const verdict = checksVerdictFixture(settings.state);
    verdict.head_sha = settings.sha;
    if (settings.required) {
      const required = checksVerdictFixture(settings.required);
      verdict.required = { state: required.state, counts: required.counts };
    }
    console.log(JSON.stringify(verdict));
  } else {
    const parsed = publicRequestSchema.parse({ ...Object.assign({}, request), op });
    if (parsed.op !== 'pr.ready') throw new Error('Unexpected public operation');
    if (settings.marker) writeFileSync(settings.marker, JSON.stringify(parsed));
    console.log(
      JSON.stringify(
        prRecordSchema.parse({
          ref: parsed.ref,
          ...parsed.expected,
          is_draft: false,
          state: 'open',
          title: 'Fixture',
          body: '',
          url: 'https://fixture.test/owner/repo/pull/42',
        })
      )
    );
  }
}
