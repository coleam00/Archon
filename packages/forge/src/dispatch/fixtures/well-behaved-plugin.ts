import { readFileSync } from 'node:fs';
import {
  resolveRequestSchema,
  checksStateRequestSchema,
  RESOLVE_OP,
  CHECKS_STATE_OP,
  FORGE_PROTOCOL_VERSION,
  type ChecksState,
} from '../../schemas';
import { checksVerdictFixture, NON_ASCII_ROUNDTRIP_FIXTURE } from '../../conformance';
const [configuration, mode, op] = process.argv.slice(2);
const settings = JSON.parse(configuration ?? '{}') as {
  state?: ChecksState;
  name?: string;
  host?: string;
  protocol?: number;
  capabilities?: string[];
  behavior?: string;
  marker?: string;
};
if (mode === 'metadata') {
  if (settings.behavior === 'stray') process.stdout.write('debug!');
  process.stdout.write(
    JSON.stringify({
      protocol: settings.protocol ?? FORGE_PROTOCOL_VERSION,
      name: settings.name ?? 'well-behaved',
      hosts: [settings.host ?? 'example-plugin.test'],
      version: '1.0.0',
      forge: 'example',
      capabilities: settings.capabilities ?? [RESOLVE_OP, CHECKS_STATE_OP],
      token_env: 'EXAMPLE_TOKEN',
    })
  );
} else {
  const request: unknown = JSON.parse(readFileSync(0, 'utf8'));
  if (settings.marker) await Bun.write(settings.marker, 'invoked');
  if (settings.behavior === 'process') {
    process.stderr.write('process failed ' + (process.env.ARCHON_FORGE_TOKEN ?? ''));
    process.exit(70);
  }
  if (settings.behavior === 'malformed') {
    process.stdout.write('debug!');
    process.exit(0);
  }
  if (op === RESOLVE_OP) {
    process.stdout.write(
      JSON.stringify({
        forge: 'example',
        repo: resolveRequestSchema.parse(request).repo,
        plugin: { name: settings.name ?? 'well-behaved', version: '1.0.0' },
      })
    );
  } else if (op === CHECKS_STATE_OP) {
    checksStateRequestSchema.parse(request);
    const verdict = checksVerdictFixture(settings.state ?? 'green');
    if (verdict.units[0])
      verdict.units[0].name =
        settings.behavior === 'env' ? JSON.stringify(process.env) : NON_ASCII_ROUNDTRIP_FIXTURE;
    process.stdout.write(JSON.stringify(verdict));
  } else {
    process.stdout.write(JSON.stringify({ kind: 'unsupported_op', op }));
    process.exit(1);
  }
}
