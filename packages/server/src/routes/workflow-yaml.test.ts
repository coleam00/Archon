import { describe, test, expect } from 'bun:test';
import { parseYaml } from '@archon/workflows/loader';
import {
  assertReadsBackAs,
  serializeWorkflowPreservingText,
  WorkflowReadBackError,
} from './workflow-yaml';

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

  test('a scalar edit leaves unrelated flow collection spacing intact', () => {
    const spaced = [
      'name: spaced',
      'nodes:',
      '  - id: a',
      '    model: opus',
      '    output_format: { type: object, required: [ x ] } # shape',
      '',
    ].join('\n');
    const text = serializeWorkflowPreservingText(
      {
        name: 'spaced',
        nodes: [{ id: 'a', model: 'sonnet', output_format: { type: 'object', required: ['x'] } }],
      },
      spaced
    );
    expect(text).toBe(spaced.replace('model: opus', 'model: sonnet'));
  });

  test('a model change in a commented, nested workflow changes exactly one line', () => {
    const original = [
      'name: deliver',
      'description: |',
      '  Implement the work, review it, and open a pull request.',
      '',
      '  Use when: decided work should become a reviewed PR.',
      '',
      '# Review establishes the first verdict; blockers loop through fix and recheck.',
      '',
      'requires: [ github ]',
      '',
      'inputs:',
      '  work:',
      '    default: ""',
      '    description: >-',
      '      What to deliver: a plan path, findings, or a description.',
      '      Empty means the trigger message is the work.',
      '',
      'nodes:',
      '  # Classify the change so review depth matches its risk.',
      '  - id: classify',
      '    model: small',
      '    prompt: |',
      '      Read the diff and choose a review tier.',
      '    output_format:',
      '      type: object',
      '      properties:',
      '        tier: { type: string, enum: [ focused, full ] }',
      '      required: [ tier ]',
      '',
      '  - id: review',
      '    depends_on: [ classify ]',
      '    when: "$classify.output.tier == \'full\'" # only on the full tier',
      '    command: review',
      '',
    ].join('\n');
    const definition = parseYaml(original) as Record<string, unknown> & {
      nodes: { id: string; model?: string }[];
    };
    definition.nodes[0].model = 'medium';
    expect(serializeWorkflowPreservingText(definition, original)).toBe(
      original.replace('    model: small', '    model: medium')
    );
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

  test('an alias whose anchor node was removed is written out as its value', () => {
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
    const text = serializeWorkflowPreservingText(
      { name: 'anchored', nodes: [{ id: 'b', output_format: { type: 'object' } }] },
      anchored
    );
    expect(text).toBe(
      'name: anchored\nnodes:\n  - id: b\n    output_format:\n      type: object\n'
    );
  });

  test('an alias moved above an anchor that also changed keeps its own value', () => {
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
        { id: 'a', output_format: { type: 'string' } },
      ],
    };
    const text = serializeWorkflowPreservingText(definition, anchored);
    expect(Bun.YAML.parse(text)).toEqual(definition);
  });

  test('an alias sent before its edited anchor in the same map keeps its own value', () => {
    const anchored = ['name: anchored', 'first: &shared', '  type: object', 'second: *shared', ''];
    const definition = {
      name: 'anchored',
      second: { type: 'object' },
      first: { type: 'string' },
    };
    const text = serializeWorkflowPreservingText(definition, anchored.join('\n'));
    expect(Bun.YAML.parse(text)).toEqual(definition);
    expect(text).not.toContain('*shared');
  });

  test('duplicate node ids are written as sent, not folded into one node', () => {
    const definition = {
      name: 'flow',
      nodes: [
        { id: 'a', command: 'first' },
        { id: 'a', command: 'second' },
      ],
    };
    const text = serializeWorkflowPreservingText(definition, authored);
    expect(Bun.YAML.parse(text)).toEqual(definition);
  });

  test('a node without an id does not take over a node that another item matches by id', () => {
    const definition = {
      name: 'flow',
      nodes: [{ command: 'anonymous' }, { id: 'a', command: 'a' }],
    };
    const text = serializeWorkflowPreservingText(definition, authored);
    expect(Bun.YAML.parse(text)).toEqual(definition);
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

  describe('a CRLF file with a quoted scalar that spans two lines', () => {
    const crlf = [
      'name: flow',
      'description: "a first line long enough to be written across lines',
      '  and a second line that follows it in the same scalar"',
      'nodes:',
      '  # the only step',
      '  - id: a',
      '    command: a',
      '',
    ].join('\r\n');
    const asLoaded = (): { nodes: { command: string }[] } & Record<string, unknown> =>
      parseYaml(crlf) as { nodes: { command: string }[] } & Record<string, unknown>;

    test('is left byte-for-byte as it was when nothing changed', () => {
      expect(asLoaded().description).toBe(
        'a first line long enough to be written across lines and a second line that follows it in the same scalar'
      );
      expect(serializeWorkflowPreservingText(asLoaded(), crlf)).toBe(crlf);
    });

    test('still reads back as sent after an edit elsewhere', () => {
      const edited = asLoaded();
      edited.nodes[0].command = 'b';
      const text = serializeWorkflowPreservingText(edited, crlf);
      expect(parseYaml(text)).toEqual(edited);
      expect(text).toBe(crlf.replace('command: a', 'command: b'));
    });
  });

  test.each([
    ["'old'", "it's new", "'it''s new'"],
    ['"old"', 'say "new"', String.raw`"say \"new\""`],
    ['old', 'true', '"true"'],
    ['old', '123', '"123"'],
    ['old', false, 'false'],
    ['"old"', 42, '42'],
    ['old', null, 'null'],
    ['false', 'false', '"false"'],
    ['old', 'colon: space', '"colon: space"'],
  ] as const)('rewrites %s as %s with schema-safe types', (old, value, expected) => {
    const source = `name: x\nvalue: ${old} # inline\nother: { a: [ b ] }\n`;
    const definition = { name: 'x', value, other: { a: ['b'] } };
    const text = serializeWorkflowPreservingText(definition, source);
    expect(text).toBe(source.replace(`value: ${old}`, `value: ${expected}`));
    expect(parseYaml(text)).toEqual(definition);
  });

  test.each(['|-', '>-', '|', '>'])('edits a %s block with its header comment', header => {
    const prefix = 'name: x\nvalue: ';
    const suffix = 'other: { a: [ b ] } # untouched\n';
    const source = `${prefix}${header} # header\n  old\n  body\n${suffix}`;
    const value = 'first\nsecond\n';
    const definition = { name: 'x', value, other: { a: ['b'] } };
    const text = serializeWorkflowPreservingText(definition, source);
    expect(text.startsWith(prefix + header[0])).toBe(true);
    expect(text.endsWith(suffix)).toBe(true);
    expect(text).toContain('# header\n');
    expect(parseYaml(text)).toEqual(definition);
  });

  test('multiple edits retain flow separators and offsets despite different lengths', () => {
    const source = 'name: x\nvalues: [ short , "old" , 3 ] # list\nother: { a: [ b ] }\n';
    const definition = { name: 'a longer name', values: ['a,b', 'x', 12], other: { a: ['b'] } };
    expect(serializeWorkflowPreservingText(definition, source)).toBe(
      source
        .replace('name: x', 'name: a longer name')
        .replace('short', '"a,b"')
        .replace('"old"', '"x"')
        .replace('3 ]', '12 ]')
    );
  });

  test.each(['|', '|-', '|+', '>', '>-', '>+'])(
    'edits a %s sequence block scalar with its header comment',
    header => {
      const prefix = 'name: x\ntags:\n  - ';
      const suffix = '  - untouched # tag\nother: { a: [ b ] } # untouched\n';
      const source = `${prefix}${header} # keep\n    old\n${suffix}`;
      const definition = { name: 'x', tags: ['new', 'untouched'], other: { a: ['b'] } };
      for (const eol of ['\n', '\r\n']) {
        const text = serializeWorkflowPreservingText(definition, source.replaceAll('\n', eol));
        expect(text).toBe(
          `${prefix}${header[0]}- # keep\n    new\n${suffix}`.replaceAll('\n', eol)
        );
        expect(parseYaml(text)).toEqual(definition);
      }
    }
  );

  test.each(['old', "'old'", '"old"'])(
    'edits a %s flow sequence scalar to a multiline value',
    scalar => {
      const prefix = 'name: x\ntags: [ ';
      const suffix = ' , untouched ] # tags\nother: { a: [ b ] } # untouched\n';
      const source = `${prefix}${scalar}${suffix}`;
      const definition = { name: 'x', tags: ['first\nsecond', 'untouched'], other: { a: ['b'] } };
      const quote = scalar.startsWith("'") ? "'" : '"';
      for (const eol of ['\n', '\r\n']) {
        const text = serializeWorkflowPreservingText(definition, source.replaceAll('\n', eol));
        expect(text).toBe(
          `${prefix}${quote}first\n\n  second${quote}${suffix}`.replaceAll('\n', eol)
        );
        expect(parseYaml(text)).toEqual(definition);
      }
    }
  );

  test('multiline quoted edits retain surrounding bytes', () => {
    const source = 'name: x\nvalue: "old" # value\nother: { a: [ b ] }\n';
    const definition = { name: 'x', value: 'first\nsecond', other: { a: ['b'] } };
    const text = serializeWorkflowPreservingText(definition, source);
    expect(text).toBe(source.replace('"old"', '"first\n\n  second"'));
  });

  test.each(['\r\n', '\n'])(
    'mixed EOL and Unicode before an edit preserve untouched bytes (%j)',
    eol => {
      const source = `name: café 🦊\r\ndescription: "first\r\n  second"\nmodel: old # model${eol}other: { a: [ b ] }\r\n`;
      const definition = {
        name: 'café 🦊',
        description: 'first second',
        model: 'new',
        other: { a: ['b'] },
      };
      expect(serializeWorkflowPreservingText(definition, source)).toBe(
        source.replace('model: old', 'model: new')
      );
    }
  );

  test('structural changes use the document merge and retain comments', () => {
    const source = '# header\nname: x\nvalue: old # value\nother: { a: [ b ] }\n';
    const definition = { name: 'x', value: 'new', other: { a: ['b'] }, added: true };
    const text = serializeWorkflowPreservingText(definition, source);
    expect(parseYaml(text)).toEqual(definition);
    expect(text).toContain('# header');
    expect(text).toContain('# value');
    expect(text).toContain('other: {a: [b]}');
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

describe('assertReadsBackAs', () => {
  test('passes when the text parses to the definition', () => {
    expect(() => {
      assertReadsBackAs('name: x\nnodes: []\n', { nodes: [], name: 'x' });
    }).not.toThrow();
  });

  test('throws when the text parses to a different document', () => {
    expect(() => {
      assertReadsBackAs('name: x\nnodes:\n  - id: a\n', { name: 'x', nodes: [{ id: 'b' }] });
    }).toThrow(WorkflowReadBackError);
  });

  test('throws when the text is not valid YAML', () => {
    expect(() => {
      assertReadsBackAs('name: [unclosed', { name: 'x' });
    }).toThrow(WorkflowReadBackError);
  });
});
