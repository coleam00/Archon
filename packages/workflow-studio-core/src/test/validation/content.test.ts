import { describe, it, expect } from 'bun:test';
import { runContentRules } from '../../validation/rules/content';
import type { DagNode } from '../../schemas';

// ---------------------------------------------------------------------------
// Helpers — flat-shape DagNode casts through `unknown`.
// Real DagNode variants have no `base` wrapper and no `type` discriminant;
// `prompt`, `depends_on`, etc. live flat on the node. See drift 6.1.1.
// ---------------------------------------------------------------------------

const prompt = (id: string, body: string, deps: string[] = []): DagNode =>
  ({ id, prompt: body, depends_on: deps }) as unknown as DagNode;

// ---------------------------------------------------------------------------

describe('content rules — when:', () => {
  it('passes a valid when: string', () => {
    const node: DagNode = {
      id: 'a',
      prompt: 'x',
      when: "$x.output.ok == 'true'",
    } as unknown as DagNode;
    expect(runContentRules([node])).toEqual([]);
  });

  it('flags an invalid when: string with the parser error', () => {
    const node: DagNode = {
      id: 'a',
      prompt: 'x',
      when: 'this is not valid',
    } as unknown as DagNode;
    const issues = runContentRules([node]);
    expect(issues.some(i => i.rule === 'content.when.parse')).toBe(true);
  });
});

describe('content rules — {{var}} scan', () => {
  it('passes when {{ids.X.Y}} resolves to an upstream node', () => {
    const issues = runContentRules([
      prompt('a', 'first'),
      prompt('b', 'use {{ids.a.output.value}}', ['a']),
    ]);
    expect(issues).toEqual([]);
  });

  it('warns when {{ids.X.Y}} references a non-upstream node', () => {
    const issues = runContentRules([
      prompt('a', 'first'),
      prompt('b', 'use {{ids.ghost.output.value}}', ['a']),
    ]);
    expect(
      issues.some(
        i => i.rule === 'content.var.unknown' && i.severity === 'warning' && i.path.nodeId === 'b'
      )
    ).toBe(true);
  });

  it('ignores {{ids.X.Y}} inside fenced code blocks', () => {
    const body = 'example:\n```\n{{ids.ghost.output.value}}\n```\nreal: {{ids.a.output.value}}';
    const issues = runContentRules([prompt('a', 'first'), prompt('b', body, ['a'])]);
    expect(issues.some(i => i.rule === 'content.var.unknown')).toBe(false);
  });

  // Lock in inline-backtick stripping (second pass of stripFences).
  it('ignores {{ids.X.Y}} inside inline code spans', () => {
    const body = 'docs: `{{ids.ghost.output.value}}` real: {{ids.a.output.value}}';
    const issues = runContentRules([prompt('a', 'first'), prompt('b', body, ['a'])]);
    expect(issues.some(i => i.rule === 'content.var.unknown')).toBe(false);
  });

  // Multiple distinct unknown refs in one body → multiple issues.
  it('emits one issue per distinct unknown {{var}} ref', () => {
    const body = 'a: {{ids.ghost1.output.x}}, b: {{ids.ghost2.output.y}}';
    const issues = runContentRules([prompt('a', 'first'), prompt('b', body, ['a'])]).filter(
      i => i.rule === 'content.var.unknown'
    );
    expect(issues.length).toBeGreaterThanOrEqual(2);
    const ids = new Set(
      issues.map(i => i.message.match(/"([^"]+)"/)?.[1]).filter(Boolean) as string[]
    );
    expect(ids.has('ghost1')).toBe(true);
    expect(ids.has('ghost2')).toBe(true);
  });

  // Nested-field body coverage: approval.message must be scanned.
  it('scans approval.message for unknown {{var}} refs', () => {
    const approvalNode = {
      id: 'b',
      approval: { message: 'confirm? {{ids.ghost.output.value}}' },
      depends_on: ['a'],
    } as unknown as DagNode;
    const issues = runContentRules([prompt('a', 'first'), approvalNode]);
    expect(issues.some(i => i.rule === 'content.var.unknown' && i.path.nodeId === 'b')).toBe(true);
  });

  // Nested-field body coverage: loop.prompt must be scanned.
  it('scans loop.prompt for unknown {{var}} refs', () => {
    const loopNode = {
      id: 'b',
      loop: { prompt: 'iterate {{ids.ghost.output.value}}', until: 'done', max_iterations: 5 },
      depends_on: ['a'],
    } as unknown as DagNode;
    const issues = runContentRules([prompt('a', 'first'), loopNode]);
    expect(issues.some(i => i.rule === 'content.var.unknown' && i.path.nodeId === 'b')).toBe(true);
  });

  // id-with-dashes is valid (the regex's [\w-]* allows it).
  it('accepts ids with dashes in {{ids.X.Y}} refs', () => {
    const issues = runContentRules([
      prompt('node-a', 'first'),
      prompt('b', 'use {{ids.node-a.output.value}}', ['node-a']),
    ]);
    expect(issues).toEqual([]);
  });
});
