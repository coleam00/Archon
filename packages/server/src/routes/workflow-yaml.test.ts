import { describe, test, expect } from 'bun:test';
import { serializeWorkflowPreservingText } from './workflow-yaml';

const authored = [
  '# flow header',
  'name: flow',
  'nodes:',
  '  # first step',
  '  - id: a',
  '    command: a',
  '  # second step',
  '  - id: b',
  '    command: b',
  '  # third step',
  '  - id: c',
  '    bash: |',
  '      echo c',
  '',
].join('\n');

describe('serializeWorkflowPreservingText', () => {
  test('a new workflow is written as block-style YAML, not one flow line', () => {
    const text = serializeWorkflowPreservingText(
      { name: 'fresh', nodes: [{ id: 'a', command: 'a' }] },
      undefined
    );
    expect(text).toBe('name: fresh\nnodes:\n  - id: a\n    command: a\n');
  });

  test('removing a middle node keeps the comments of the nodes around it', () => {
    const text = serializeWorkflowPreservingText(
      {
        name: 'flow',
        nodes: [
          { id: 'a', command: 'a' },
          { id: 'c', bash: 'echo c\n' },
        ],
      },
      authored
    );
    expect(text).not.toContain('id: b');
    expect(text).not.toContain('# second step');
    expect(text).toContain('# flow header');
    expect(text).toContain('# first step\n  - id: a');
    expect(text).toContain('# third step\n  - id: c');
    expect(text).toContain('bash: |\n      echo c');
  });

  test('a changed field is rewritten and an added one appended, the rest untouched', () => {
    const text = serializeWorkflowPreservingText(
      {
        name: 'flow',
        nodes: [
          { id: 'a', command: 'a2' },
          { id: 'b', command: 'b', depends_on: ['a'] },
          { id: 'c', bash: 'echo c\n' },
        ],
      },
      authored
    );
    expect(text).toBe(
      authored
        .replace('command: a\n', 'command: a2\n')
        .replace('    command: b\n', '    command: b\n    depends_on:\n      - a\n')
    );
  });

  test('lines the edit does not touch keep their exact spacing', () => {
    const spaced = [
      'name: spaced',
      'nodes:',
      '  - id: a',
      '    model: opus',
      '    output_format: { type: object, required: [ x ] }',
      '    allowed_tools: [Read,  Grep]',
      '',
    ].join('\n');
    const text = serializeWorkflowPreservingText(
      {
        name: 'spaced',
        nodes: [
          {
            id: 'a',
            model: 'sonnet',
            output_format: { type: 'object', required: ['x'] },
            allowed_tools: ['Read', 'Grep'],
          },
        ],
      },
      spaced
    );
    expect(text).toBe(spaced.replace('model: opus', 'model: sonnet'));
  });

  test('a key appended after a reformatted line leaves that line alone', () => {
    const spaced = ['name: spaced', 'nodes:', '  - id: a', '    with: { x: 1 }', ''].join('\n');
    const text = serializeWorkflowPreservingText(
      { name: 'spaced', nodes: [{ id: 'a', with: { x: 1 }, model: 'opus' }] },
      spaced
    );
    expect(text).toBe(spaced.replace('{ x: 1 }\n', '{ x: 1 }\n    model: opus\n'));
  });

  test('an edit elsewhere keeps anchors and aliases whose value did not change', () => {
    const anchored = [
      'name: anchored',
      'nodes:',
      '  - id: a',
      '    model: opus',
      '    output_format: &gate',
      '      type: object',
      '  - id: b',
      '    output_format: *gate',
      '  - id: c',
      '    output_format: *gate',
      '',
    ].join('\n');
    const gate = { type: 'object' };
    const text = serializeWorkflowPreservingText(
      {
        name: 'anchored',
        nodes: [
          { id: 'a', model: 'sonnet', output_format: { ...gate } },
          { id: 'b', output_format: { ...gate } },
          { id: 'c', output_format: { ...gate } },
        ],
      },
      anchored
    );
    expect(text).toBe(anchored.replace('model: opus', 'model: sonnet'));
  });

  test('an alias whose value changed becomes its own value, the others stay aliases', () => {
    const anchored = [
      'name: anchored',
      'nodes:',
      '  - id: a',
      '    output_format: &gate',
      '      type: object',
      '  - id: b',
      '    output_format: *gate',
      '  - id: c',
      '    output_format: *gate',
      '',
    ].join('\n');
    const definition = {
      name: 'anchored',
      nodes: [
        { id: 'a', output_format: { type: 'object' } },
        { id: 'b', output_format: { type: 'string' } },
        { id: 'c', output_format: { type: 'object' } },
      ],
    };
    const text = serializeWorkflowPreservingText(definition, anchored);
    expect(Bun.YAML.parse(text)).toEqual(definition);
    expect(text).toContain('  - id: c\n    output_format: *gate');
    expect(text).not.toContain('  - id: b\n    output_format: *gate');
  });

  test('an alias moved above its anchor is written out as its value', () => {
    const anchored = [
      'name: anchored',
      'nodes:',
      '  - id: a',
      '    output_format: &gate',
      '      type: object',
      '  - id: b',
      '    output_format: *gate',
      '',
    ].join('\n');
    const definition = {
      name: 'anchored',
      nodes: [
        { id: 'b', output_format: { type: 'object' } },
        { id: 'a', output_format: { type: 'object' } },
      ],
    };
    const text = serializeWorkflowPreservingText(definition, anchored);
    expect(Bun.YAML.parse(text)).toEqual(definition);
    expect(text).toContain('&gate');
  });

  test('a CRLF file stays CRLF and valid when its commented nodes are reordered', () => {
    const crlf = authored.replace(/\n/g, '\r\n');
    const definition = {
      name: 'flow',
      nodes: [
        { id: 'c', bash: 'echo c\n' },
        { id: 'b', command: 'b' },
        { id: 'a', command: 'a' },
      ],
    };
    const text = serializeWorkflowPreservingText(definition, crlf);
    expect(text).not.toMatch(/\r\r|[^\r]\n/);
    expect(Bun.YAML.parse(text)).toEqual(definition);
    expect(text).toContain('# first step\r\n  - id: a');
  });

  test('a long single-line value is not folded', () => {
    const long = 'word '.repeat(40).trim();
    const text = serializeWorkflowPreservingText({ name: 'x', description: long }, 'name: x\n');
    expect(text).toBe(`name: x\ndescription: ${long}\n`);
  });

  test('an unparseable file on disk is replaced by the definition', () => {
    const text = serializeWorkflowPreservingText({ name: 'x', nodes: [] }, 'name: [unclosed');
    expect(text).toBe('name: x\nnodes: []\n');
  });
});
