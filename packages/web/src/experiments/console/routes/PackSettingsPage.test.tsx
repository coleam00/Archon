import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { PackSettings } from './PackSettingsPage';

const setting = (name: string, value: string | null, fallback: string | null = null) => ({
  name,
  description: `What ${name} is for.`,
  type: 'string' as const,
  default: fallback,
  value,
});

function render(element: React.ReactElement): Document {
  const dom = new Window();
  dom.document.body.innerHTML = renderToStaticMarkup(element);
  return dom.document as unknown as Document;
}

test("a setting shows the project's value, or the pack's default when the project sets none", () => {
  const page = render(
    <PackSettings
      settings={[setting('command', 'make test', 'true'), setting('policy', null, 'policy.md')]}
    />
  );
  const row = (name: string) => page.querySelector(`[data-setting="${name}"]`);
  expect(row('command')?.querySelector('[data-setting-value]')?.textContent).toBe('make test');
  expect(row('command')?.hasAttribute('data-set')).toBe(true);
  expect(row('policy')?.querySelector('[data-setting-value]')?.textContent).toBe('policy.md');
  expect(row('policy')?.hasAttribute('data-set')).toBe(false);
});

test('settings sit under the sections the pack declares, and the rest follow', () => {
  const page = render(
    <PackSettings
      settings={[setting('a', null), setting('b', null), setting('c', null)]}
      sections={[{ name: 'Policies', settings: ['c', 'a'] }]}
    />
  );
  expect(
    [...page.querySelectorAll('[data-setting-section]')].map(section => [
      section.getAttribute('data-setting-section'),
      [...section.querySelectorAll('[data-setting]')].map(row => row.getAttribute('data-setting')),
    ])
  ).toEqual([
    ['Policies', ['c', 'a']],
    ['', ['b']],
  ]);
});
