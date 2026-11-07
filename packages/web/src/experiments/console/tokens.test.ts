import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { compile } from 'tailwindcss';

test('console tokens preserve inherited line height, shared radii and decimal dimensions', async () => {
  const source = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');
  const theme = source.slice(source.indexOf('@theme inline'), source.indexOf('@keyframes'));
  const defaults = readFileSync(new URL(import.meta.resolve('tailwindcss/theme.css')), 'utf8');
  const compiler = await compile(`${defaults}\n${theme}\n@tailwind utilities;`);
  const css = compiler.build([
    'text-console-12',
    'text-console-34',
    'leading-relaxed',
    'rounded-sm',
    'rounded-md',
    'rounded-lg',
    'rounded-xl',
    'rounded-console-12',
    'rounded-console-16',
    'rounded-br',
    'tracking-console-label',
    'py-2.75',
    'w-37.5',
    'w-0.75',
    'gap-4.5',
  ]);
  function declarations(utility: string): string {
    const selector = `.${utility.replaceAll('.', '\\.')} {`;
    const start = css.indexOf(selector);
    expect(start).toBeGreaterThanOrEqual(0);
    return css.slice(start + selector.length, css.indexOf('}', start));
  }
  expect(declarations('text-console-12').trim()).toBe('font-size: 12px;');
  expect(declarations('text-console-34').trim()).toBe('font-size: 34px;');
  expect(declarations('leading-relaxed')).toContain('line-height: var(--leading-relaxed)');
  expect(declarations('rounded-sm')).toContain('calc(var(--radius) - 4px)');
  expect(declarations('rounded-md')).toContain('calc(var(--radius) - 2px)');
  expect(declarations('rounded-lg')).toContain('border-radius: var(--radius)');
  expect(declarations('rounded-xl')).toContain('calc(var(--radius) + 4px)');
  expect(declarations('rounded-console-12')).toContain('border-radius: 12px');
  expect(declarations('rounded-console-16')).toContain('border-radius: 16px');
  expect(declarations('rounded-br')).toContain('border-bottom-right-radius: 0.25rem');
  expect(declarations('tracking-console-label')).toContain('letter-spacing: 0.14em');
  expect(declarations('py-2.75')).toContain('padding-block: calc(var(--spacing) * 2.75)');
  expect(declarations('w-37.5')).toContain('width: calc(var(--spacing) * 37.5)');
  expect(declarations('w-0.75')).toContain('width: calc(var(--spacing) * 0.75)');
  expect(declarations('gap-4.5')).toContain('gap: calc(var(--spacing) * 4.5)');
});
