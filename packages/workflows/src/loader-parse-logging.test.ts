// @archon-test-isolated
import { afterAll, afterEach, expect, test } from 'bun:test';
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

test('a YAML syntax error shows its file, position and source line to the author, not the log', () => {
  setLogSink(line => lines.push(line));
  const yaml = 'name: private\ndescription: ARCHON_PARSE_SECRET_SENTINEL: stray\nnodes: []\n';
  const result = parseWorkflow(yaml, 'private.yaml', providerRegistry);
  expect(result.error?.error).toStartWith('private.yaml:2:14: YAML syntax error:');
  expect(result.error?.error).toContain('ARCHON_PARSE_SECRET_SENTINEL: stray');
  expect(lines.join('')).not.toContain('ARCHON_PARSE_SECRET_SENTINEL');
  expect(lines.map(line => JSON.parse(line))).toContainEqual(
    expect.objectContaining({
      msg: 'workflow_parse_failed',
      filename: 'private.yaml',
      line: 2,
      col: 14,
    })
  );
});
