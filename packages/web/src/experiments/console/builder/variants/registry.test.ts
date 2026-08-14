/**
 * Drift guard for the two hand-maintained mirrors of this registry that live
 * outside `@archon/web` and therefore cannot import it.
 *
 * `@archon/core`'s `propose-workflow-edits-tool.ts` (the Builder Copilot's
 * native tool) re-lists both the variant ids and the node-id pattern as
 * literals. If they drift, the Copilot silently rejects a legitimate variant
 * with "unknown variant 'x'", which reads to the author as a Copilot bug rather
 * than a missing registration.
 *
 * This test is the tripwire: it lives on the side where a variant actually gets
 * ADDED, so the build breaks here with a message naming the file to mirror.
 */
import { describe, expect, test } from 'bun:test';
import { VARIANTS, VARIANT_REGISTRY, isVariantId } from './registry';
import { NODE_ID_PATTERN } from '../editor/state';

/** Keep in sync with `KNOWN_VARIANTS` in
 *  `packages/core/src/orchestrator/propose-workflow-edits-tool.ts`. */
const CORE_MIRRORED_VARIANTS: readonly string[] = [
  'prompt',
  'command',
  'bash',
  'script',
  'loop',
  'approval',
  'cancel',
];

/** Keep in sync with `NODE_ID_PATTERN` in the same core file. */
const CORE_MIRRORED_ID_PATTERN = '^[a-zA-Z_][a-zA-Z0-9_-]*$';

describe('variant registry ↔ @archon/core mirror', () => {
  test('VARIANTS matches KNOWN_VARIANTS in propose-workflow-edits-tool.ts', () => {
    expect([...(VARIANTS as readonly string[])].sort()).toEqual([...CORE_MIRRORED_VARIANTS].sort());
  });

  test('every registry variant is accepted by isVariantId', () => {
    for (const v of VARIANTS) expect(isVariantId(v)).toBe(true);
  });

  test('NODE_ID_PATTERN matches the pattern mirrored in propose-workflow-edits-tool.ts', () => {
    expect(NODE_ID_PATTERN.source).toBe(CORE_MIRRORED_ID_PATTERN);
  });

  /**
   * The Copilot tool's `inputSchema` enumerates these field names so the agent
   * emits the right `data` keys. A live Claude turn guessed `script` for bash
   * (it is `bash`) and `prompt` for approval (it is `message`), producing a
   * proposal blocked by "must not be empty" — so these names are load-bearing,
   * not documentation.
   */
  test('per-variant data keys match those enumerated in propose-workflow-edits-tool.ts', () => {
    const actual = Object.fromEntries(
      VARIANTS.map(v => [v, [...(VARIANT_REGISTRY[v].dataKeys as readonly string[])].sort()])
    );
    expect(actual).toEqual({
      prompt: ['prompt'],
      command: ['command'],
      bash: ['bash', 'timeout'],
      script: ['deps', 'runtime', 'script', 'timeout'],
      loop: [
        'command',
        'fresh_context',
        'gate_message',
        'interactive',
        'max_iterations',
        'prompt',
        'until',
        'until_bash',
      ],
      approval: ['capture_response', 'message', 'on_reject'],
      cancel: ['reason'],
    });
  });

  /**
   * `dataKeys` must be a SUPERSET of the initialized fields. Deriving the
   * Copilot allow-list from `defaultData()` alone was the original bug: it
   * silently rejected every optional field (bash `timeout`, script `deps`,
   * approval `capture_response`, …) that the workflow schema supports.
   */
  test('dataKeys is a superset of defaultData() keys for every variant', () => {
    for (const v of VARIANTS) {
      const declared = new Set<string>(VARIANT_REGISTRY[v].dataKeys as readonly string[]);
      for (const k of Object.keys(VARIANT_REGISTRY[v].defaultData())) {
        expect({ variant: v, key: k, declared: declared.has(k) }).toEqual({
          variant: v,
          key: k,
          declared: true,
        });
      }
    }
  });
});
