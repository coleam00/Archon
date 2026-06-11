import { describe, test, expect } from 'bun:test';
import {
  CLIPBOARD_VERSION,
  copySelection,
  parseEnvelope,
  pasteEnvelope,
  serializeEnvelope,
} from './clipboard';
import { FIXTURES } from '../fixtures';
import { fromWorkflowDefinition } from '../model';
import type { BuilderWorkflow } from '../types';
import type { XYPosition } from '../flow/types';

const mixed: BuilderWorkflow = fromWorkflowDefinition(FIXTURES.mixed).workflow;

const positions = new Map<string, XYPosition>([
  ['classify', { x: 0, y: 0 }],
  ['fix', { x: 100, y: 160 }],
  ['report', { x: 0, y: 320 }],
]);

describe('copySelection', () => {
  test('returns null for an empty selection', () => {
    expect(copySelection(mixed, new Set(), positions)).toBeNull();
  });

  test('keeps internal deps and drops external ones', () => {
    const envelope = copySelection(mixed, new Set(['fix', 'report']), positions);
    expect(envelope).not.toBeNull();
    if (envelope === null) return;
    const report = envelope.nodes.find(n => n.id === 'report');
    // 'classify' is outside the selection — dropped; 'fix' is internal — kept.
    expect(report?.base.depends_on).toEqual(['fix']);
    const fix = envelope.nodes.find(n => n.id === 'fix');
    expect(fix?.base.depends_on).toBeUndefined();
  });

  test('captures positions for the copied nodes only', () => {
    const envelope = copySelection(mixed, new Set(['fix']), positions);
    expect(envelope?.positions).toEqual({ fix: { x: 100, y: 160 } });
  });
});

describe('envelope serialization', () => {
  test('JSON round-trip preserves the envelope', () => {
    const envelope = copySelection(mixed, new Set(['fix', 'report']), positions);
    expect(envelope).not.toBeNull();
    if (envelope === null) return;
    expect(parseEnvelope(serializeEnvelope(envelope))).toEqual(envelope);
  });

  test('rejects foreign or malformed payloads', () => {
    expect(parseEnvelope('')).toBeNull();
    expect(parseEnvelope('not json')).toBeNull();
    expect(parseEnvelope('{"version":"other","nodes":[]}')).toBeNull();
    expect(parseEnvelope(JSON.stringify({ version: CLIPBOARD_VERSION, nodes: 'x' }))).toBeNull();
  });
});

describe('pasteEnvelope', () => {
  test('keeps ids that do not collide', () => {
    const envelope = copySelection(mixed, new Set(['fix']), positions);
    if (envelope === null) throw new Error('expected envelope');
    const { nodes } = pasteEnvelope(envelope, new Set(['unrelated']));
    expect(nodes.map(n => n.id)).toEqual(['fix']);
  });

  test('remaps colliding ids and rewires internal deps through the remap', () => {
    const envelope = copySelection(mixed, new Set(['fix', 'report']), positions);
    if (envelope === null) throw new Error('expected envelope');
    const existing = new Set(mixed.nodes.map(n => n.id));
    const { nodes } = pasteEnvelope(envelope, existing);

    expect(nodes.map(n => n.id)).toEqual(['fix-copy', 'report-copy']);
    expect(nodes.find(n => n.id === 'report-copy')?.base.depends_on).toEqual(['fix-copy']);
  });

  test('second paste gets the next suffix', () => {
    const envelope = copySelection(mixed, new Set(['fix']), positions);
    if (envelope === null) throw new Error('expected envelope');
    const { nodes } = pasteEnvelope(envelope, new Set(['fix', 'fix-copy']));
    expect(nodes.map(n => n.id)).toEqual(['fix-copy-2']);
  });

  test('offsets positions, keyed by the post-remap id', () => {
    const envelope = copySelection(mixed, new Set(['fix']), positions);
    if (envelope === null) throw new Error('expected envelope');
    const { positions: pasted } = pasteEnvelope(envelope, new Set(['fix']), { x: 10, y: 20 });
    expect(pasted.get('fix-copy')).toEqual({ x: 110, y: 180 });
  });

  test('node data is carried verbatim', () => {
    const envelope = copySelection(mixed, new Set(['fix']), positions);
    if (envelope === null) throw new Error('expected envelope');
    const { nodes } = pasteEnvelope(envelope, new Set(['fix']));
    const pasted = nodes[0];
    expect(pasted?.variant).toBe('command');
    if (pasted?.variant === 'command') {
      expect(pasted.data.command).toBe('implement-fix');
    }
    expect(pasted?.base.model).toBe('opus');
    expect(pasted?.base.when).toBe("$classify.output == 'BUG'");
  });
});
