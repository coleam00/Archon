/**
 * Repository-level parity checks: the web UI's copies of two engine grammars —
 * the `$<nodeId>.output` reference and the `when:` comparison atom — must stay
 * identical to the engine's originals.
 *
 * `@archon/web` must never import `@archon/workflows` (a server package), and
 * `api.generated.d.ts` is type-only so it cannot carry a runtime value — the
 * same constraint AGENTS.md records for `TRIGGER_RULES`. The web package
 * therefore keeps deliberate copies of both grammars, and these checks are what
 * keep those copies honest.
 *
 * They live in `scripts/` rather than beside the web modules because this is a
 * cross-package repository invariant, not a unit of `@archon/web` behavior — the
 * same reason the bundled-defaults and capability-matrix checks live here. Every
 * file is read as TEXT, so no package boundary is crossed. `bun run test` ends
 * with `bun test ./scripts/`, so CI enforces it.
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
const ENGINE_CONDITIONS = join(REPO_ROOT, 'packages', 'workflows', 'src', 'condition-evaluator.ts');
const WEB_NODE_REF = join(REPO_ROOT, 'packages', 'web', 'src', 'lib', 'node-ref.ts');
const WEB_WHEN_GRAMMAR = join(
  REPO_ROOT,
  'packages',
  'web',
  'src',
  'experiments',
  'console',
  'builder',
  'validation',
  'when-grammar.ts'
);

function missing(name: string, file: string): Error {
  return new Error(
    `Could not find \`${name}\` in ${file}. If it was renamed or moved, re-point this ` +
      'parity check and its counterpart together — they are meant to change as a pair.'
  );
}

/**
 * Both extractors anchor the declaration to the start of its line (`^\s*`, `m`).
 * Without that they take the FIRST textual match, so a commented-out copy holding
 * the CURRENT value — an ordinary thing to find above a constant someone is
 * mid-refactor on — shadows a genuinely drifted live one and the whole suite
 * passes. That was verified, not theorised: unanchored, a dropped hyphen in
 * `NODE_ID_SOURCE` plus an extra `when:` operator in `atomPattern` left this file
 * at 3 pass / 0 fail. A guard that can be silently defeated is worse than none,
 * because it buys confidence in exactly the invariant it fails to check.
 */
const DECL = String.raw`^\s*(?:export )?const`;

/**
 * Extract a `const <name> = String.raw`…`` literal, failing loudly if it moved.
 * Also accepts the `new RegExp(String.raw`…`)` wrapper, which is how a composed
 * pattern is spelled.
 */
function rawConstant(file: string, name: string): string {
  const source = readFileSync(file, 'utf8');
  const match = new RegExp(
    String.raw`${DECL} ${name} =\s*(?:new RegExp\(\s*)?String\.raw\x60([^\x60]*)\x60`,
    'm'
  ).exec(source);
  if (match?.[1] === undefined) throw missing(name, file);
  return match[1];
}

/** Extract a `const <name> = /…/;` regex literal, joining a wrapped one back up. */
function regexConstant(file: string, name: string): string {
  const source = readFileSync(file, 'utf8');
  const match = new RegExp(String.raw`${DECL} ${name} =\s*\/([\s\S]*?)\/;`, 'm').exec(source);
  if (match?.[1] === undefined) throw missing(name, file);
  return match[1]
    .split('\n')
    .map(line => line.trim())
    .join('');
}

/** Resolve the `${NAME}` interpolations a composed web pattern is built from. */
function resolveInterpolations(pattern: string, parts: Record<string, string>): string {
  let resolved = pattern;
  for (const [name, value] of Object.entries(parts)) {
    resolved = resolved.replaceAll(`\${${name}}`, value);
  }
  return resolved;
}

describe('node-ref parity: @archon/web mirrors the engine', () => {
  test('the web OUTPUT_REF_SOURCE is byte-identical to the engine definition', () => {
    // The web copy interpolates NODE_ID_SOURCE, so compare the resolved value.
    const engine = rawConstant(ENGINE_LOADER, 'OUTPUT_REF_SOURCE');
    const nodeId = rawConstant(WEB_NODE_REF, 'NODE_ID_SOURCE');
    const web = resolveInterpolations(rawConstant(WEB_NODE_REF, 'OUTPUT_REF_SOURCE'), {
      NODE_ID_SOURCE: nodeId,
    });

    expect(web).toBe(engine);
  });

  test('the shared grammar admits a hyphenated id (the #2567 regression)', () => {
    // Asserted by MATCHING, not by string equality: a lockstep widening of the
    // grammar on both sides is legitimate and should pass here, while the
    // regression this pins — dropping the hyphen — still fails. Byte-identity
    // with the engine is the previous test's job, not this one's.
    const nodeId = new RegExp(`^${rawConstant(WEB_NODE_REF, 'NODE_ID_SOURCE')}$`);

    expect(nodeId.test('check-reproduction')).toBe(true);
    expect(nodeId.test('classify-testability')).toBe(true);
  });

  // The builder's `when:` parser makes the same "mirrors the engine" claim about
  // a second grammar. It was held by a comment alone; a divergence would let a
  // condition validate clean in the builder and fail to parse at run time.
  test("the builder's when-atom pattern is byte-identical to the condition evaluator's", () => {
    // Engine side is a `/…/` literal; the web side composes a `String.raw`.
    const engine = regexConstant(ENGINE_CONDITIONS, 'atomPattern');
    const web = resolveInterpolations(rawConstant(WEB_WHEN_GRAMMAR, 'ATOM_PATTERN'), {
      NODE_ID_SOURCE: rawConstant(WEB_NODE_REF, 'NODE_ID_SOURCE'),
      SEGMENT_SOURCE: rawConstant(WEB_WHEN_GRAMMAR, 'SEGMENT_SOURCE'),
    });

    expect(web).toBe(engine);
  });
});
