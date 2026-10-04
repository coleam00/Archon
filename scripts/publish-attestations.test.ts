import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a workflow mapping');
  }
  return value as Record<string, unknown>;
}

const workflow: unknown = Bun.YAML.parse(
  readFileSync(resolve(import.meta.dir, '../.github/workflows/publish.yml'), 'utf8')
);
const steps = record(record(record(workflow).jobs).docker).steps;
if (!Array.isArray(steps)) throw new Error('Expected publish steps');
const build = record(steps.find((step: unknown) => record(step).name === 'Build and push'));
const verify = record(
  steps.find((step: unknown) => record(step).name === 'Verify published attestations')
);
const script = verify.run;
if (typeof script !== 'string') throw new Error('Expected an attestation verification script');

const provenance = JSON.stringify({
  'linux/amd64': { SLSA: { buildType: 'https://mobyproject.org/buildkit@v1' } },
  'linux/arm64': { SLSA: { buildType: 'https://mobyproject.org/buildkit@v1' } },
});
const sbom = JSON.stringify({
  'linux/amd64': { SPDX: { spdxVersion: 'SPDX-2.3' } },
  'linux/arm64': { SPDX: { spdxVersion: 'SPDX-2.3' } },
});

function runVerification(
  provenanceOutput: string,
  sbomOutput: string,
  inspectExit = 0
): {
  exitCode: number;
  output: string;
} {
  const result = Bun.spawnSync(
    [
      'bash',
      '-e',
      '-o',
      'pipefail',
      '-c',
      `
docker() {
  test "$1 $2 $3" = 'buildx imagetools inspect' || return 90
  test "$4" = 'ghcr.io/coleam00/archon@sha256:test-digest' || return 91
  test "$5" = '--format' || return 92
  if [ "$TEST_INSPECT_EXIT" != '0' ]; then
    echo 'registry inspection failed' >&2
    return "$TEST_INSPECT_EXIT"
  fi
  case "$6" in
    '{{ json .Provenance }}') printf '%s' "$TEST_PROVENANCE" ;;
    '{{ json .SBOM }}') printf '%s' "$TEST_SBOM" ;;
    *) return 93 ;;
  esac
}
${script}`,
    ],
    {
      env: {
        ...process.env,
        REGISTRY: 'ghcr.io',
        IMAGE_NAME: 'coleam00/Archon',
        DIGEST: 'sha256:test-digest',
        TEST_PROVENANCE: provenanceOutput,
        TEST_SBOM: sbomOutput,
        TEST_INSPECT_EXIT: String(inspectExit),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  return { exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

test('publish checks the pushed digest after producing provenance and SBOM', () => {
  expect(build.id).toBe('build');
  expect(record(build.with).provenance).toBe('mode=max');
  expect(record(build.with).sbom).toBe(true);
  expect(record(verify.env).DIGEST).toBe('${{ steps.build.outputs.digest }}');
  expect(verify.shell).toBe('bash');
  expect(steps.indexOf(verify)).toBeGreaterThan(steps.indexOf(build));
  expect(runVerification(provenance, sbom).exitCode).toBe(0);
});

test.each([
  ['no output', ''],
  ['null', 'null'],
  ['no attestations', '{}'],
  ['empty platform record', '{"linux/amd64":{}}'],
  ['empty predicates', '{"linux/amd64":{"SLSA":{},"SPDX":{}}}'],
  [
    'one empty platform',
    '{"linux/amd64":{"SLSA":{"buildType":"buildkit"},"SPDX":{"spdxVersion":"SPDX-2.3"}},"linux/arm64":{}}',
  ],
  ['invalid JSON', 'invalid'],
])('publish fails for %s in either attestation', (_name, empty) => {
  const missingProvenance = runVerification(empty, sbom);
  expect(missingProvenance.exitCode).not.toBe(0);
  expect(missingProvenance.output).toContain('::error::Missing or empty provenance attestation');
  const missingSbom = runVerification(provenance, empty);
  expect(missingSbom.exitCode).not.toBe(0);
  expect(missingSbom.output).toContain('::error::Missing or empty SBOM attestation');
});

test('publish preserves registry inspection failures', () => {
  const result = runVerification(provenance, sbom, 42);
  expect(result.exitCode).toBe(42);
  expect(result.output).toContain('registry inspection failed');
});
