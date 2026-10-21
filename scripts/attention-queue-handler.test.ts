import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const guide = readFileSync(
  join(import.meta.dir, '../packages/docs-web/src/content/docs/getting-started/operate.md'),
  'utf8'
);
function extractHandler(guide: string): string {
  const handler = guide
    .replaceAll('\r\n', '\n')
    .split('  - id: answer\n')[1]
    ?.split('    bash: |\n')[1]
    ?.split('\n```')[0];
  if (!handler?.includes('answers=$decide.output.answers')) {
    throw new Error('Cannot locate the published attention-queue answer handler');
  }
  return handler
    .split('\n')
    .map(line => line.slice(6))
    .join('\n')
    .replace('$decide.output.answers', '"$TEST_ANSWERS"');
}
const script = extractHandler(guide);

test('published handler extraction accepts LF and CRLF checkouts', () => {
  const lfGuide = guide.replaceAll('\r\n', '\n');
  expect(extractHandler(lfGuide.replaceAll('\n', '\r\n'))).toBe(extractHandler(lfGuide));
});

const answers = JSON.stringify([
  { runId: 'first', occurrence: 'first-pause', option: 'retry' },
  { runId: 'second', occurrence: 'second-pause', option: 'stop' },
]);

function runHandler(input: string, firstStatus = 0, firstOk = true) {
  return Bun.spawnSync(
    [
      'bash',
      '-c',
      `archon() {
        printf 'attempt:%s\\n' "$3" >&2
        if [ "$3" = first ]; then
          printf '{"ok":%s,"reason":"first-result"}\\n' "$FIRST_OK"
          return "$FIRST_STATUS"
        fi
        printf '{"ok":true}\\n'
      }
      ${script}`,
    ],
    {
      env: {
        ...process.env,
        TEST_ANSWERS: input,
        FIRST_STATUS: String(firstStatus),
        FIRST_OK: String(firstOk),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
}

test.each([
  { status: 0, ok: true, expected: 0 },
  { status: 1, ok: false, expected: 1 },
  { status: 0, ok: false, expected: 1 },
  { status: 1, ok: true, expected: 1 },
])('published handler continues after first result $status/$ok', ({ status, ok, expected }) => {
  const result = runHandler(answers, status, ok);
  const stderr = result.stderr.toString();
  expect(stderr.match(/^attempt:.+$/gm)).toEqual(['attempt:first', 'attempt:second']);
  expect(result.exitCode).toBe(expected);
  if (expected !== 0) expect(stderr).toContain('first-result');
});

test('published handler fails when the answer-list producer fails', () => {
  const result = runHandler('not-json');
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).not.toContain('attempt:');
});

test('published handler accepts an empty queue without sending answers', () => {
  const result = runHandler('[]');
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).not.toContain('attempt:');
});
