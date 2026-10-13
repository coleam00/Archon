import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { serverReleaseAsset } from '../packages/paths/src/server-launch';

// `* text=auto` checks this workflow out with CRLF on Windows CI. Normalizing here lets every
// pattern below anchor on LF, so a stray `\r` can never reach a capture.
const workflow = readFileSync(
  resolve(import.meta.dir, '../.github/workflows/release.yml'),
  'utf8'
).replace(/\r\n/g, '\n');

test('release checksums include each release artifact once', () => {
  const targets = [...workflow.matchAll(/^ +target: (\S+)$/gm)].map(match => match[1]);
  const binaries = [...workflow.matchAll(/^ +binary: (\S+)$/gm)].map(match => match[1]);
  const webDist = workflow.match(/^ *-czf dist\/(\S+) /m)?.[1];
  const checksumOperands = workflow.match(/^ *sha256sum (.+) > checksums\.txt$/m)?.[1];

  // A missed derivation would leave nothing to compare and pass vacuously.
  if (
    targets.length === 0 ||
    binaries.length !== targets.length ||
    webDist === undefined ||
    checksumOperands === undefined
  ) {
    throw new Error('release.yml no longer declares the artifacts or checksum command read here');
  }

  const releaseArtifacts = [...binaries, ...targets.map(serverReleaseAsset), webDist];
  const operands = checksumOperands.split(/\s+/).map(operand => new Bun.Glob(operand));

  // `sha256sum` writes one row per operand that names a file, so an artifact covered by two
  // operands is checksummed twice (#2377) and one covered by no operand is missing entirely.
  const rowsPerArtifact = Object.fromEntries(
    releaseArtifacts.map(artifact => [
      artifact,
      operands.filter(operand => operand.match(artifact)).length,
    ])
  );

  expect(rowsPerArtifact).toEqual(
    Object.fromEntries(releaseArtifacts.map(artifact => [artifact, 1]))
  );
});

test('build job uploads the server asset for every release target', () => {
  const buildJob = workflow.match(/^  build:\n([\s\S]*?)(?=^  \S)/m)?.[1];
  if (buildJob === undefined) throw new Error('Missing release build job');
  const targets = [...buildJob.matchAll(/^ +target: (\S+)$/gm)].map(match => match[1]);
  const uploadPaths = buildJob.match(
    /uses: actions\/upload-artifact@[^\n]+\n\s+with:\n\s+name: [^\n]+\n\s+path: \|\n((?: {12}[^\n]+\n)+)/
  )?.[1];
  if (targets.length === 0 || uploadPaths === undefined) {
    throw new Error('Missing release build matrix or upload paths');
  }
  const paths = uploadPaths
    .trim()
    .split(/\s*\n\s*/)
    .map(pattern => new Bun.Glob(pattern));
  for (const target of targets) {
    const asset = `dist/${serverReleaseAsset(target)}`;
    expect(paths.some(pattern => pattern.match(asset))).toBe(true);
  }
});
