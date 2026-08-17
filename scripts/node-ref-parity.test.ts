/**
 * Repository-level parity check: the web UI's `$<nodeId>.output` definition must
 * stay identical to the engine's.
 *
 * `@archon/web` must never import `@archon/workflows` (a server package), and
 * `api.generated.d.ts` is type-only so it cannot carry a runtime value — the
 * same constraint AGENTS.md records for `TRIGGER_RULES`. The web package
 * therefore keeps a deliberate copy of the grammar, and this check is what keeps
 * that copy honest.
 *
 * It lives in `scripts/` rather than beside the web module because it is a
 * cross-package repository invariant, not a unit of `@archon/web` behavior — the
 * same reason the bundled-defaults and capability-matrix checks live here. Both
 * files are read as TEXT, so no package boundary is crossed. `bun run test` runs
 * this directory, so CI enforces it.
 *
 * The drift this catches actually happened: the builder's legacy copy used
 * `\w`, which excludes the hyphen, so it silently validated none of the
 * hyphenated node ids the bundled workflows use (#2567).
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');
const ENGINE_LOADER = join(REPO_ROOT, 'packages', 'workflows', 'src', 'loader.ts');
const WEB_NODE_REF = join(REPO_ROOT, 'packages', 'web', 'src', 'lib', 'node-ref.ts');

/** Extract a `const <name> = String.raw`…`` literal, failing loudly if it moved. */
function rawConstant(file: string, name: string): string {
  const source = readFileSync(file, 'utf8');
  const match = new RegExp(String.raw`const ${name} = String\.raw\x60([^\x60]*)\x60`).exec(source);
  if (match?.[1] === undefined) {
    throw new Error(
      `Could not find \`${name}\` in ${file}. If it was renamed or moved, re-point this ` +
        'parity check and its counterpart together — they are meant to change as a pair.'
    );
  }
  return match[1];
}

describe('node-ref parity: @archon/web mirrors the engine', () => {
  test('the web OUTPUT_REF_SOURCE is byte-identical to the engine definition', () => {
    // The web copy interpolates NODE_ID_SOURCE, so compare the resolved value.
    const engine = rawConstant(ENGINE_LOADER, 'OUTPUT_REF_SOURCE');
    const webNodeId = rawConstant(WEB_NODE_REF, 'NODE_ID_SOURCE');
    const webOutputRef = rawConstant(WEB_NODE_REF, 'OUTPUT_REF_SOURCE').replace(
      '${NODE_ID_SOURCE}',
      webNodeId
    );

    expect(webOutputRef).toBe(engine);
  });

  test('the shared grammar admits the hyphen (the #2567 regression)', () => {
    expect(rawConstant(WEB_NODE_REF, 'NODE_ID_SOURCE')).toBe('[a-zA-Z_][a-zA-Z0-9_-]*');
  });
});
