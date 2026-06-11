import { describe, test, expect } from 'bun:test';
import { serializeToYaml } from './serialize';
import { FIXTURES } from '../fixtures';
import type { WireWorkflowDefinition } from '../types';

describe('serializeToYaml', () => {
  test('golden: minimal prompt workflow', () => {
    const def: WireWorkflowDefinition = {
      name: 'hello',
      description: 'Say hello.',
      nodes: [{ id: 'greet', prompt: 'Say hello to the user.' }],
    };
    expect(serializeToYaml(def)).toBe(
      [
        'name: hello',
        'description: Say hello.',
        '',
        'nodes:',
        '  - id: greet',
        '    prompt: Say hello to the user.',
        '',
      ].join('\n')
    );
  });

  test('golden: meta, depends_on, when, and variant satellites', () => {
    const yaml = serializeToYaml(FIXTURES.mixed);
    expect(yaml).toBe(
      [
        'name: mixed-fixture',
        'description: Classify, branch on the result, and finish.',
        'provider: claude',
        'model: sonnet',
        'tags:',
        '  - triage',
        '  - demo',
        '',
        'nodes:',
        '  - id: classify',
        '    prompt: Classify the issue as BUG or FEATURE. Reply with one word.',
        '    output_type: classification',
        '  - id: fix',
        '    depends_on:',
        '      - classify',
        '    when: "$classify.output == \'BUG\'"',
        '    command: implement-fix',
        '    model: opus',
        '    persist_session: true',
        '  - id: report',
        '    depends_on:',
        '      - classify',
        '      - fix',
        '    trigger_rule: all_done',
        '    bash: "echo \'done: $classify.output\'"',
        '    timeout: 15000',
        '',
      ].join('\n')
    );
  });

  test('multi-line strings render as literal block scalars', () => {
    const def: WireWorkflowDefinition = {
      name: 'multiline',
      description: '',
      nodes: [{ id: 'p', prompt: 'line one\nline two' }],
    };
    const yaml = serializeToYaml(def);
    expect(yaml).toContain('    prompt: |\n      line one\n      line two');
  });

  test('nested loop object indents and quotes ambiguous scalars', () => {
    const def: WireWorkflowDefinition = {
      name: 'loopy',
      description: '',
      nodes: [
        {
          id: 'iterate',
          loop: {
            prompt: 'Fix the next failing test.',
            until: 'COMPLETE',
            max_iterations: 5,
            fresh_context: false,
          },
        },
      ],
    };
    expect(serializeToYaml(def)).toBe(
      [
        'name: loopy',
        '',
        'nodes:',
        '  - id: iterate',
        '    loop:',
        '      prompt: Fix the next failing test.',
        '      until: COMPLETE',
        '      max_iterations: 5',
        '      fresh_context: false',
        '',
      ].join('\n')
    );
  });

  test('every fixture serializes without throwing and starts with its name', () => {
    for (const [key, fixture] of Object.entries(FIXTURES)) {
      const yaml = serializeToYaml(fixture);
      expect(yaml.startsWith(`name: ${fixture.name}`)).toBe(true);
      expect(yaml.includes('nodes:')).toBe(true);
      expect(yaml.endsWith('\n')).toBe(true);
      // Every node id appears as a list item.
      for (const node of fixture.nodes) {
        expect(yaml).toContain(`- id: ${node.id}`);
      }
      expect(key.length).toBeGreaterThan(0);
    }
  });

  test('scalars a YAML parser would re-type are quoted', () => {
    const cases: [string, string][] = [
      ['1e5', '"1e5"'], // scientific notation → float
      ['0x1A', '"0x1A"'], // hex → int
      ['0o17', '"0o17"'], // octal → int
      ['+5', '"+5"'], // signed int
      ['.inf', '".inf"'], // infinity
      ['.NaN', '".NaN"'], // not-a-number
      ['True', '"True"'], // YAML 1.2 boolean spelling
      ['NULL', '"NULL"'], // null spelling
      ['~', '"~"'], // null shorthand
      ['yes', '"yes"'], // YAML 1.1 boolean (other parsers)
      ['Off', '"Off"'],
    ];
    for (const [raw, quoted] of cases) {
      const yaml = serializeToYaml({
        name: 'quoting',
        description: '',
        nodes: [{ id: 'n', prompt: 'p', output_type: raw }],
      });
      expect(yaml).toContain(`output_type: ${quoted}`);
    }
    // Non-ambiguous strings stay plain.
    const plain = serializeToYaml({
      name: 'quoting',
      description: '',
      nodes: [{ id: 'n', prompt: 'p', output_type: '1.2.3-beta' }],
    });
    expect(plain).toContain('output_type: 1.2.3-beta');
  });

  test('empty arrays and objects render inline', () => {
    const def: WireWorkflowDefinition = {
      name: 'edge-cases',
      description: 'true',
      nodes: [{ id: 'n', prompt: '42', skills: [] }],
    };
    const yaml = serializeToYaml(def);
    expect(yaml).toContain('description: "true"');
    expect(yaml).toContain('prompt: "42"');
    expect(yaml).toContain('skills: []');
  });
});
