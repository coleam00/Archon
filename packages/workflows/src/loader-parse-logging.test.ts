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
