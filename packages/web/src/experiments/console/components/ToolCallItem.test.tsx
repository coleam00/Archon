import { describe, test, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolCallDetails, ToolCallItem } from './ToolCallItem';
import type { InlineToolCall } from '../primitives/message';
import { pathTokens, type PathToken } from '../lib/run-paths';
import { StreamContextProvider } from '../lib/stream-context';

const render = (
  call: InlineToolCall,
  props: { paths?: readonly PathToken[]; exact?: boolean } = {}
): string =>
  renderToStaticMarkup(
    <StreamContextProvider value={{ runStartedAt: '2026-10-02T09:59:00.000Z' }}>
      <ToolCallItem call={call} timestamp="2026-10-02T10:00:00.000Z" {...props} />
    </StreamContextProvider>
  );

/** What a browser would put on screen for `html`: tags gone, entities decoded. */
const textOf = (html: string): string =>
  html
    .replace(/<[^>]+>/g, '')
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&amp;', '&');

describe('ToolCallItem disclosure', () => {
  test('a call with detail to show is toggled by a native button', () => {
    const html = render({ name: 'Bash', input: 'x'.repeat(120) });
    expect(html).toContain('<button type="button" aria-expanded="false"');
  });

  test('a call with no input or output has nothing to toggle', () => {
    expect(render({ name: 'Bash', input: {} })).not.toContain('<button');
  });

  test('the detail holds the command exactly as recorded, before the input', () => {
    const command = 'cd "C:\\w\\x" && grep -n "a b" src/*.rs';
    const html = renderToStaticMarkup(
      <ToolCallDetails call={{ name: command, input: { command } }} command={command} hasInput />
    );
    expect(textOf(html)).toContain(command);
    expect(html.indexOf('aria-label="Command"')).toBeLessThan(html.indexOf('{'));
  });
});

describe('ToolCallItem row', () => {
  const WORKTREE = 'C:\\Users\\me\\.archon\\workspaces\\acme\\app\\worktrees\\feat\\x';
  const RUN = 'C:\\Users\\me\\.archon\\workspaces\\acme\\app\\artifacts\\runs\\0a81ff6c';
  const paths = pathTokens([
    { kind: 'checkout', path: WORKTREE },
    { kind: 'run_artifacts', path: RUN },
  ]);
  const command = `cd "${WORKTREE}" && cat "${RUN.replaceAll('\\', '/')}/plan.md" src/lib.rs`;
  // The Claude provider titles a shell call with its command.
  const described: InlineToolCall = {
    name: command,
    input: { command, description: 'Read the plan and the library entry point' },
  };

  test("the agent's description leads and the command follows it", () => {
    const text = textOf(render(described, { paths }));
    expect(text.indexOf('Read the plan')).toBeGreaterThan(-1);
    expect(text.indexOf('Read the plan')).toBeLessThan(text.indexOf('cat "'));
    // The command is on the row once, not again as an argument summary.
    expect(text.split('cat "').length).toBe(2);
    expect(text).not.toContain('description=');
  });

  test('drops the cd into the checkout and names known paths, the full path on hover', () => {
    const html = render(described, { paths });
    const text = textOf(html);
    expect(text).toContain('cat "‹run›/plan.md" src/lib.rs');
    expect(text).not.toContain('cd "');
    expect(text).not.toContain('workspaces');
    expect(html).toContain(`title="${RUN}"`);
  });

  test('exact shows a described command in full, wrapped instead of cut off', () => {
    const html = render(described, { exact: true });
    expect(textOf(html)).toContain(command);
    expect(html).toContain('whitespace-pre-wrap');
    expect(html).not.toContain('truncate');
  });

  test('exact shows every argument of a call with no description in full', () => {
    const file = `${WORKTREE}\\src\\a-very-long-directory-name\\another-long-one\\lib.rs`;
    const text = textOf(
      render({ name: 'Read', input: { file_path: file, limit: 40, offset: 2 } }, { exact: true })
    );
    expect(text).toContain(`Readfile_path="${file}" limit=40 offset=2`);
    expect(text).not.toContain('…');
    const raw = 'y'.repeat(120);
    expect(textOf(render({ name: 'Bash', input: raw }, { exact: true }))).toContain(`"${raw}"`);
  });

  test('a described call with no command keeps its name on the second line', () => {
    const text = textOf(
      render({ name: 'Task', input: { description: 'Survey the parser', prompt: 'p' } }, { paths })
    );
    expect(text.indexOf('Survey the parser')).toBeLessThan(text.indexOf('Task'));
  });

  test('a call with no description shows its name, then its arguments', () => {
    const file = `${WORKTREE}\\src\\a-very-long-directory-name\\another-long-one\\lib.rs`;
    const html = render(
      { name: 'Read', input: { file_path: file, limit: 40, offset: 2 } },
      { paths }
    );
    const text = textOf(html);
    expect(text).toContain(
      'Readfile_path="‹worktree›\\src\\a-very-long-directory-name\\anothe…" limit=40 +1'
    );
    expect(html).toContain(`title="${WORKTREE}"`);
    // No paths, as in a chat: the same row, with the path as recorded.
    expect(textOf(render({ name: 'Read', input: { file_path: 'a.rs' } }))).toContain(
      'Readfile_path="a.rs"'
    );
  });
});
