// @archon-test-isolated
import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { getLogLevel, setLogLevel, setLogSink } from '@archon/paths';
import { providerRegistry } from '@archon/providers';
import { parseWorkflow } from './loader';

const originalLevel = getLogLevel();
setLogLevel('debug');
const lines: string[] = [];

afterEach(() => {
  setLogSink(undefined);
  lines.length = 0;
});

afterAll(() => setLogLevel(originalLevel));

test('malformed YAML logs the file without copying source into serialized diagnostics', () => {
  setLogSink(line => lines.push(line));
  const yaml = 'name: private\ndescription: ARCHON_PARSE_SECRET_SENTINEL\nnodes: [';
  const result = parseWorkflow(yaml, 'private.yaml', providerRegistry);
  expect(result.error).toMatchObject({ filename: 'private.yaml', errorType: 'parse_error' });
  expect(lines.join('')).not.toContain('ARCHON_PARSE_SECRET_SENTINEL');
  expect(lines.join('')).not.toContain('name: private');
  expect(lines.map(line => JSON.parse(line))).toContainEqual(
    expect.objectContaining({ msg: 'workflow_parse_failed', filename: 'private.yaml' })
  );
});

test('source-bearing parser errors retain location and author diagnostics without entering logs', () => {
  setLogSink(line => lines.push(line));
  const message = 'Unexpected token at line 7: ARCHON_PARSE_SECRET_SENTINEL';
  const parser = spyOn(Bun.YAML, 'parse').mockImplementation(() => {
    throw new SyntaxError(message);
  });
  try {
    const result = parseWorkflow('private source', 'private.yaml', providerRegistry);
    expect(result.error).toEqual({
      filename: 'private.yaml',
      errorType: 'parse_error',
      error: `YAML parse error (near line 7): ${message}`,
    });
    expect(lines.join('')).not.toContain('ARCHON_PARSE_SECRET_SENTINEL');
    expect(lines.map(line => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        msg: 'workflow_parse_failed',
        filename: 'private.yaml',
        lineInfo: ' (near line 7)',
      })
    );
  } finally {
    parser.mockRestore();
  }
});

test('node deprecation events preserve identities, payloads and first-encounter grouping', () => {
  setLogSink(line => lines.push(line));
  const result = parseWorkflow(
    `
name: legacy-fields
description: Legacy fields retain their warnings
nodes:
  - id: prose
    loop:
      prompt: work
      until: DONE
      max_iterations: 3
      interactive: true
      gate_message: ok?
  - id: group
    depends_on: [prose]
    loop_group:
      until: DONE
      max_iterations: 3
      interactive: false
      gate_message: ok?
      nodes:
        - id: nested
          approval:
            message: ok?
            on_reject: { prompt: fix }
            capture_response: false
  - id: plain
    depends_on: [group]
    approval: { message: ok? }
  - id: select
    depends_on: [plain]
    approval: { message: choose, decisions: [{ id: approve }] }
  - id: inc
    depends_on: [select]
    include: reusable
`,
    'legacy.yaml',
    providerRegistry
  );
  expect(result.error).toBeNull();
  const events = lines
    .map(line => JSON.parse(line))
    .filter(event =>
      [
        'node_loop_until_deprecated',
        'node_loop_group_until_deprecated',
        'legacy_pause_deprecated',
      ].includes(event.msg)
    );
  expect(events).toEqual([
    expect.objectContaining({
      level: 20,
      msg: 'node_loop_until_deprecated',
      id: 'prose',
      warning: expect.stringContaining("the prose 'loop.until'"),
    }),
    expect.objectContaining({
      level: 20,
      msg: 'node_loop_group_until_deprecated',
      id: 'group',
      warning: expect.stringContaining("the prose 'loop_group.until'"),
    }),
    expect.objectContaining({
      level: 20,
      msg: 'legacy_pause_deprecated',
      shape: 'interactive_loop',
      nodeIds: ['prose', 'group'],
      warning: expect.stringMatching(
        /Node 'prose': 'loop\.interactive'.*Node 'group': 'loop_group\.interactive'/
      ),
    }),
    expect.objectContaining({
      level: 20,
      msg: 'legacy_pause_deprecated',
      shape: 'on_reject',
      nodeIds: ['nested'],
    }),
    expect.objectContaining({
      level: 20,
      msg: 'legacy_pause_deprecated',
      shape: 'capture_response',
      nodeIds: ['nested'],
    }),
    expect.objectContaining({
      level: 20,
      msg: 'legacy_pause_deprecated',
      shape: 'approval',
      nodeIds: ['plain'],
    }),
    expect.objectContaining({
      level: 20,
      msg: 'legacy_pause_deprecated',
      shape: 'decisions',
      nodeIds: ['select'],
    }),
  ]);
  for (const event of events) expect(event.warning).toEqual(expect.any(String));
});
