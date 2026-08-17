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
 * same reason the bundled-defaults and capability-matrix checks live here. This
 * file importing both packages does not breach the rule above: the rule is about
 * what ships in the web bundle, and nothing here is bundled. `bun run test` ends
 * with `bun test ./scripts/`, so CI enforces it.
 *
 * The drift this catches actually happened, twice:
 *   - #2567 — the builder's legacy copy used `\w`, which excludes the hyphen, so
 *     it silently validated none of the hyphenated node ids the bundled
 *     workflows use.
 *   - #2591 — #2579 added a `$INPUTS.<name>` branch to the engine atom, and the
 *     builder's copy did not follow, so `when: "$INPUTS.mode == 'fast'"` was an
 *     error in the builder and a clean load in the engine.
 *
 * TWO MECHANISMS, deliberately, because the two grammars are spelled differently:
 *
 *   - The `$<nodeId>.output` reference is a plain `String.raw` literal on both
 *     sides, so it is compared as TEXT (see the decoy analysis on `DECL` below).
 *   - The `when:` atom is COMPOSED from several constants on both sides, so it is
 *     compared by EXECUTING both modules. Reading a composition as text is what
 *     broke here: #2570 scraped `const atomPattern = /…/;` out of
 *     `condition-evaluator.ts`, #2579 moved it to `when-atom.ts` and rebuilt it as
 *     a `new RegExp(...)` concatenation, and the scraper could only report that it
 *     had lost its target. Comparing compiled `.source` cannot be broken that way,
 *     and — unlike any regex over source text — it cannot be fooled by a
 *     commented-out copy either, because a comment does not execute.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  WHEN_ATOM_PATTERN,
  parseWhenAtom,
  splitOutsideQuotes,
  whenAtoms,
  type WhenAtom,
} from '../packages/workflows/src/when-atom';
import {
  ATOM_PATTERN,
  parse,
} from '../packages/web/src/experiments/console/builder/validation/when-grammar';
import { dagNodeSchema } from '../packages/workflows/src/schemas';
import { validateStructural } from '../packages/web/src/experiments/console/builder/validation/structural';

const REPO_ROOT = join(import.meta.dir, '..');
const ENGINE_LOADER = join(REPO_ROOT, 'packages', 'workflows', 'src', 'loader.ts');
const WEB_NODE_REF = join(REPO_ROOT, 'packages', 'web', 'src', 'lib', 'node-ref.ts');

function missing(name: string, file: string): Error {
  return new Error(
    `Could not find \`${name}\` in ${file}. If it was renamed or moved, re-point this ` +
      'parity check and its counterpart together — they are meant to change as a pair.'
  );
}

/**
 * A regex over raw source cannot tell a DECLARATION from a MENTION of one. That
 * is the whole difficulty here, and every layer below is about narrowing the gap
 * — none of them closes it, so treat this as "cheap steps toward reading code",
 * not as a solved problem. (The `when:` checks further down close it by executing
 * the modules instead; this layer remains only for the plain-literal grammar.)
 *
 * The failure mode is concrete: a commented-out copy holding the CURRENT value,
 * sitting above a live constant that has genuinely drifted. That is an ordinary
 * thing to find in a file someone is mid-refactor on, and it makes the whole
 * suite pass while the invariant is broken. Measured against the real test file,
 * each row with the #2567 regression (a dropped hyphen in `NODE_ID_SOURCE`) live:
 *
 *   extractor                  `// …`      `/*` indented   `/*` at column 0
 *   no anchor                  DEFEATED    DEFEATED        DEFEATED
 *   `^\s*(?:export )?const`    caught      DEFEATED        DEFEATED
 *   `^(?:export )?const`       caught      caught          DEFEATED
 *   + strip comments first     caught      caught          caught
 *
 * Hence both layers, which are complementary rather than redundant: stripping
 * removes commented-out copies whatever their indentation, and the column-0
 * anchor still rejects a mention embedded mid-line in live code, which stripping
 * leaves untouched.
 *
 * Column 0 is safe rather than brittle: all three constants this file extracts are
 * top-level, and an indented one would not be. If a future constant is nested,
 * widen deliberately and re-run the decoy matrix — do not reach for `\s*`.
 *
 * A guard that can be silently defeated is worse than no guard: it buys
 * confidence in exactly the invariant it is failing to check.
 */
const DECL = String.raw`^(?:export )?const`;

/** Drop block comments and whole-line `//` comments before matching. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Extract a `const <name> = String.raw`…`` literal, failing loudly if it moved. */
function rawConstant(file: string, name: string): string {
  const source = stripComments(readFileSync(file, 'utf8'));
  const match = new RegExp(String.raw`${DECL} ${name} =\s*String\.raw\x60([^\x60]*)\x60`, 'm').exec(
    source
  );
  if (match?.[1] === undefined) throw missing(name, file);
  return match[1];
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
});

/**
 * The `when:` atom, compared by running both parsers rather than reading them.
 *
 * The two checks below are complementary, and neither subsumes the other:
 *
 *   - `.source` identity pins the GRAMMAR, including the parts no corpus entry
 *     happens to exercise. An alternation branch added to one side only fails
 *     here immediately, which is exactly what #2591 needed and did not have.
 *   - the corpus pins the PARSE SEMANTICS around the grammar — the rules that run
 *     before the regex sees a substring (the `||`/`&&` splitter) and after it
 *     matches. `$INPUTS.a.b` is the standing example of the latter: both patterns
 *     match it (it backtracks into the node branch), and only the follow-up
 *     reserved-id rejection makes it an error. Identical patterns with a missing
 *     rejection would pass the first check and fail here.
 *
 * Each accepted entry is compared THREE ways — verdict, atom list, and GROUPING.
 * The third is not redundant: both parsers flatten `||`/`&&` into an ordered list,
 * and splitting on two disjoint separators in either order yields the same list,
 * so a one-sided precedence swap is invisible to an atom-list comparison no matter
 * how many entries it has. It is caught only by comparing the AND/OR shape.
 *
 * Honest limit: the corpus catches a semantic divergence only where it has an
 * entry. A new rule on one side only, in a case no entry covers, still slips
 * through — so a change to either parser should arrive with a corpus entry. The
 * splitter is the weaker half: the atom pattern is pinned exhaustively by
 * `.source` (every character of the compiled regex), while the splitter — written
 * out by hand on both sides, and textually different while behaviourally
 * identical, so no `.toString()` trick applies — is pinned only for the strings
 * enumerated below, plus their grouping.
 *
 * The ordering itself — `||` outer, `&&` inner — is written here rather than read
 * from the engine, so this pins the BUILDER against that contract, not the engine
 * against it. An engine-side precedence change is caught instead by
 * `condition-evaluator.test.ts` ("&& has higher precedence than ||"), behaviourally,
 * on a truth table.
 */
describe('when-atom parity: the builder parses what the engine parses', () => {
  test("the builder's atom pattern is byte-identical to the engine's", () => {
    expect(ATOM_PATTERN.source).toBe(WHEN_ATOM_PATTERN.source);
    expect(ATOM_PATTERN.flags).toBe(WHEN_ATOM_PATTERN.flags);
  });

  /**
   * Every grammar feature, plus both historical regressions. Each entry is
   * compared for the same accept/reject verdict AND the same decomposition.
   */
  const CORPUS: readonly string[] = [
    // Canonical, field access, and the `$node.field` shorthand.
    "$classify.output == 'BUG'",
    "$classify.output.type != 'FEATURE'",
    '$build.exit_code == 0',
    "$a.field.sub == 'x'",
    // #2567: hyphenated ids, which the builder's legacy `\w` copy rejected.
    "$check-reproduction.output == 'done'",
    "$classify-testability.output.testable == 'e2e_testable'",
    // #2591: the `$INPUTS.<name>` scope #2579 added to the engine.
    "$INPUTS.mode == 'fast'",
    "$INPUTS.my-input == 'x'",
    "$INPUTS.output == 'x'",
    '$INPUTS.retries >= 3',
    // Pins case PRESERVATION of the captured name, which the entries above do not: they are all
    // lowercase, so a parser that normalises the name still agrees with the engine on every one.
    // (`$INPUTSX` pins the SCOPE's case-sensitivity — a different rule.)
    "$INPUTS.baseBranch == 'main'",
    "$INPUTS.a.b == 'x'",
    // The only entry that catches the reserved-id rule being DELETED (the two below
    // catch it being MIS-SPELLED). `$INPUTS.a.b` backtracks into the node branch and is
    // then caught by the shorthand-cannot-carry-a-sub-field rule anyway, so it still
    // agrees with a parser that has forgotten `INPUTS` is reserved. This one does not:
    // `output` is the canonical segment, so a parser missing the rule accepts it as a
    // field read on a node called `INPUTS`. Found by deleting the rule and watching the
    // suite stay green.
    "$INPUTS.output.x == 'y'",
    "$INPUTS == 'x'",
    "$INPUTS. == 'x'",
    // A node whose id merely STARTS with the scope name is an ordinary node. Pins the
    // reserved-id check against the `startsWith('INPUTS')` spelling a hand-written
    // mirror reaches for, which would reject this one.
    "$INPUTSX.output.x == 'y'",
    // The scope name is matched case-sensitively, so this is a node called `inputs`.
    "$inputs.mode == 'x'",
    // Every operator, in both RHS spellings.
    "$n.output == '5'",
    "$n.output != '5'",
    "$n.output < '5'",
    "$n.output > '5'",
    "$n.output <= '5'",
    "$n.output >= '5'",
    '$n.output == true',
    '$n.output == false',
    '$score.output.value >= -0.5',
    "$n.output == ''",
    // Compound expressions — the only entries that reach the quote-aware splitter,
    // which is hand-duplicated on both sides. Unlike the atom pattern it has no
    // exhaustive pin, so these carry it by example; the grouping assertion below is
    // what makes them catch a precedence divergence rather than just an atom-set one.
    "$a.output == 'X' && $b.output == 'Y'",
    "$a.output == 'X' || $b.output == 'Y'",
    "$a.output == 'X' && $b.output == 'Y' || $c.output == 'Z'",
    // Mixed precedence across four atoms: correct grouping is [1,2,1], and splitting
    // `&&` outer instead would give [2,2]. The three-atom case above discriminates
    // too, but this one fails on shape LENGTH as well, not only on distribution.
    "$a.output == 'X' || $b.output == 'Y' && $c.output == 'Z' || $d.output == 'W'",
    "$a.output == 'x && y || z'",
    "$INPUTS.mode == 'fast' && $classify.output.type == 'BUG'",
    // Splitter edges: an unterminated quote (which leaves the scanner in-quote to the
    // end), a separator flush against a closing quote with no whitespace, and doubled
    // separators that leave an empty atom between them.
    "$a.output == 'x",
    "$a.output == 'X'&&$b.output == 'Y'",
    "$a.output == 'X' &&&& $b.output == 'Y'",
    "$a.output == 'X' |||| $b.output == 'Y'",
    // Malformed.
    '',
    '   ',
    'garbage',
    '$a.output ~~ 5',
    '$a.output == unquoted',
    '$a.output == yes',
    '$a.output ==',
    '$1bad.output == 1',
    "$a.output == 'X' &&",
  ];

  /**
   * The canonical spelling of an atom's left-hand side. Normalizing erases the
   * spellings the two sides legitimately record differently (the web keeps
   * `shorthand`/`bare` so it can round-trip an author's text; the engine has no
   * reason to) and leaves the meaning, which is what must agree.
   */
  function engineRef(atom: WhenAtom): string {
    if (atom.ref.kind === 'input') return `$INPUTS.${atom.ref.name}`;
    return atom.ref.field === undefined
      ? `$${atom.ref.nodeId}.output`
      : `$${atom.ref.nodeId}.output.${atom.ref.field}`;
  }

  /** `null` means "rejected"; an array means "accepted, and here is what it means". */
  function engineParse(expr: string): string[] | null {
    const atoms = whenAtoms(expr).map(parseWhenAtom);
    if (atoms.some(atom => atom === null)) return null;
    return atoms.map(atom => {
      // Narrowed by the `some` guard above; `flatMap` would lose that.
      if (atom === null) throw new Error('unreachable');
      return `${engineRef(atom)} ${atom.operator} ${JSON.stringify(atom.expected)}`;
    });
  }

  function webParse(expr: string): string[] | null {
    const result = parse(expr);
    if (!result.ok) return null;
    return result.ast.or.flatMap(group =>
      group.map(atom => {
        const ref =
          atom.kind === 'input'
            ? `$INPUTS.${atom.name}`
            : atom.field === undefined
              ? `$${atom.nodeId}.output`
              : `$${atom.nodeId}.output.${atom.field}`;
        return `${ref} ${atom.op} ${JSON.stringify(atom.value)}`;
      })
    );
  }

  /**
   * The AND/OR shape as a list of group sizes — `[2, 1]` for `a && b || c`.
   *
   * The engine has no grouped parse to compare against (`whenAtoms` flattens on
   * purpose, because its callers want every atom, not the boolean structure), so
   * the expected shape is derived from the engine's OWN exported splitter. That
   * keeps this a cross-package comparison rather than the web checking itself.
   *
   * `null` for a rejected expression, so the two sides stay comparable on the
   * malformed entries as well.
   */
  function engineGroupShape(expr: string): number[] | null {
    if (engineParse(expr) === null) return null;
    return splitOutsideQuotes(expr.trim(), '||').map(
      clause => splitOutsideQuotes(clause, '&&').length
    );
  }

  function webGroupShape(expr: string): number[] | null {
    const result = parse(expr);
    return result.ok ? result.ast.or.map(group => group.length) : null;
  }

  for (const expr of CORPUS) {
    test(`agrees on ${JSON.stringify(expr)}`, () => {
      expect(webParse(expr)).toEqual(engineParse(expr));
      // Not implied by the line above: both sides flatten, and `a && b || c` and
      // `a || b && c` flatten to the SAME ordered atom list. Only the grouping
      // separates them, and getting it wrong changes the boolean formula the
      // builder writes back through `format()`.
      expect(webGroupShape(expr)).toEqual(engineGroupShape(expr));
    });
  }
});

/**
 * Loop completion-channel parity: the console builder's copy of the engine's
 * channel rules must reach the same verdict as `dagNodeSchema` on the same input.
 *
 * Both copies carry the instruction "verify agreement by parsing both, never by
 * reading them" (`packages/workflows/src/schemas/loop.ts`,
 * `builder/validation/structural.ts`). Until this check they were kept in step by
 * twin test matrices with matching case NAMES — which is prose, and prose is the
 * mechanism this file already records failing twice (#2567, #2591). The twins stay
 * as per-package regression tests; this is what makes them a guard rather than a
 * convention.
 *
 * Why the rules are duplicated at all: `@archon/web` must never import
 * `@archon/workflows`, and `api.generated.d.ts` is type-only so it cannot carry a
 * runtime rule — the same constraint as the two grammars above.
 *
 * The comparison is BY VERDICT, not by message: the builder reports issues for its
 * own UI and the engine returns Zod issues, so only "accepted / rejected" is
 * meaningfully shared. That is exactly the axis that broke in #2591.
 */
describe('loop completion-channel parity', () => {
  /**
   * `until_field` names a property in the node's `output_format`, and the engine
   * additionally checks that it is declared, required and boolean — rules the
   * builder deliberately does not mirror (it has no schema editor). Supplying a
   * valid schema for those cases keeps this a comparison of the CHANNEL rule, so a
   * disagreement here means the channel rules drifted, not that the two sides
   * validate different things.
   */
  const OUTPUT_FORMAT = {
    type: 'object',
    properties: { done: { type: 'boolean' } },
    required: ['done'],
  };

  type Channels = { until?: string; until_bash?: string; until_field?: string };

  const CORPUS: Channels[] = [
    {},
    { until: 'COMPLETE' },
    { until_bash: 'bun run test' },
    { until_field: 'done' },
    { until: 'COMPLETE', until_bash: 'bun run test' },
    { until: 'COMPLETE', until_field: 'done' },
    { until_bash: 'bun run test', until_field: 'done' },
    { until: 'COMPLETE', until_bash: 'bun run test', until_field: 'done' },
    // Blank in each position, beside a valid sibling and alone — the shape that
    // broke once already: an aggregate-only gate accepted a blank field whenever
    // another channel was valid, while the builder rejected it.
    { until: '' },
    { until: '   ' },
    { until: '\t' },
    { until_bash: '' },
    { until_bash: '   ' },
    { until_bash: '\n' },
    { until_field: '' },
    { until_field: '  ' },
    { until: '   ', until_bash: 'bun run test' },
    { until: 'COMPLETE', until_bash: '   ' },
    { until: 'COMPLETE', until_field: '  ' },
    { until: '  ', until_field: 'done' },
    { until: ' ', until_bash: '\t' },
    // Legitimate values that must NOT be rejected: validation trims to decide, but
    // never rewrites what it stores, so padding and indentation stay acceptable.
    { until: ' COMPLETE ' },
    { until_bash: '  set -e\n  test -f done\n' },
  ];

  function engineAccepts(channels: Channels): boolean {
    const needsSchema = channels.until_field !== undefined;
    return dagNodeSchema.safeParse({
      id: 'l',
      ...(needsSchema ? { output_format: OUTPUT_FORMAT } : {}),
      loop: { prompt: 'iterate', max_iterations: 5, ...channels },
    }).success;
  }

  function builderAccepts(channels: Channels): boolean {
    const issues = validateStructural({
      name: 'w',
      description: 'd',
      meta: {},
      nodes: [
        {
          id: 'l',
          variant: 'loop',
          base: {},
          data: { prompt: 'iterate', max_iterations: 5, fresh_context: false, ...channels },
        },
      ],
    });
    // Only the channel fields — the builder also reports unrelated required-field
    // issues, and this check owns the channel rule alone.
    return !issues.some(issue => issue.path.field?.startsWith('loop.until'));
  }

  for (const channels of CORPUS) {
    test(`agrees on ${JSON.stringify(channels)}`, () => {
      expect(builderAccepts(channels)).toBe(engineAccepts(channels));
    });
  }
});
