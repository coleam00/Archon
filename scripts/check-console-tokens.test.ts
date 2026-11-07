import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  checkRepository,
  checkSource,
  needsToken,
  renderTokenDocs,
  updateTokenDocs,
} from './check-console-tokens';

const roots = trackTempRoots();
const theme =
  '@theme inline { --text-console-12: 12px; --radius-sm: calc(var(--radius) - 4px); --tracking-console-label: 0.14em; }';
const guide = '<!-- console-tokens:start -->\n<!-- console-tokens:end -->';
const check = (text: string): string[] => checkSource('fixture.tsx', text);

describe('console token utility boundary', () => {
  test.each([
    'text-[12px]',
    'text-[length:0.8rem]',
    'rounded-tl-[3px]',
    'rounded-s-[1em]',
    'tracking-[-0.1px]',
    'md:hover:!text-[12px]',
    'md:text-[12px]!',
    'hover:-translate-y-[1px]',
    '-mt-[2rem]',
    'gap-x-[11px]',
    'space-y-[1em]',
    'p-[11px]',
    'ms-[2rem]',
    'min-w-[12px]',
    'max-h-[3em]',
    'size-[12px]',
    'inset-x-[1rem]',
    'top-[2px]',
    'grid-cols-[220px_minmax(0,1fr)]',
    'w-[calc(50%-4px)]',
    '[&:hover]:h-[1em]',
    'rounded-[14px_14px_4px_14px]',
  ])('rejects %s', utility => {
    expect(needsToken(utility)).toBe(true);
    expect(check(`const classes = '${utility}';`)[0]).toContain(utility);
  });

  test.each([
    'text-console-12',
    'rounded-md',
    'py-2.75',
    'w-37.5',
    'text-[color:var(--accent)]',
    'text-[#123456]',
    'shadow-[0_0_12px_red]',
    'hover:shadow-[0_0_12px_red]',
    'ring-[3px]',
    'blur-[6px]',
    'leading-[1.5]',
    'w-[70%]',
    'h-[50vh]',
    'grid-cols-[auto_1fr]',
    'z-[1]',
    'tracking-[var(--tracking)]',
  ])('permits %s', utility => {
    expect(needsToken(utility)).toBe(false);
    expect(check(`const classes = '${utility}';`)).toEqual([]);
  });

  test('visits attributes, constants, conditionals, and every static template segment', () => {
    const source =
      'const C = "text-[12px]";\n<div className={`p-[2px] ${on ? "w-[4rem]" : "h-[1em]"} md:mt-[3px]`} />';
    const failures = check(source);
    expect(failures).toHaveLength(5);
    for (const utility of ['text-[12px]', 'p-[2px]', 'w-[4rem]', 'h-[1em]', 'md:mt-[3px]']) {
      expect(failures.some(failure => failure.includes(utility))).toBe(true);
    }
  });

  test('checks CSS apply lists and adjacent block-comment exceptions', () => {
    expect(checkSource('theme.css', '/* @apply p-[2px]; */')).toEqual([]);
    expect(
      checkSource(
        'theme.css',
        '.a { content: "/* console-token-exception p-[2px] -- Fake. */"; }\n.b { @apply p-[2px]; }'
      )
    ).toHaveLength(1);
    expect(checkSource('theme.css', '.a { @apply p-[2px]; }')).toHaveLength(1);
    expect(
      checkSource(
        'theme.css',
        '/* console-token-exception p-[2px] -- Local layout. */\n.a { @apply p-[2px]; }'
      )
    ).toEqual([]);
  });
});

const coveredUtilities = [
  'text',
  'rounded',
  ...['t', 'r', 'b', 'l', 's', 'e', 'tl', 'tr', 'br', 'bl', 'ss', 'se', 'es', 'ee'].map(
    side => `rounded-${side}`
  ),
  'tracking',
  ...['p', 'm'].flatMap(prefix =>
    ['', 'x', 'y', 't', 'r', 'b', 'l', 's', 'e'].map(side => prefix + side)
  ),
  'gap',
  'gap-x',
  'gap-y',
  'space-x',
  'space-y',
  ...['', 'min-', 'max-'].flatMap(prefix => ['w', 'h'].map(axis => prefix + axis)),
  'size',
  'inset',
  'inset-x',
  'inset-y',
  'inset-s',
  'inset-e',
  'top',
  'right',
  'bottom',
  'left',
  'start',
  'end',
  'grid-cols',
  'grid-rows',
  'translate',
  'translate-x',
  'translate-y',
  'translate-z',
];
const coveredProperties = [
  'font-size',
  'letter-spacing',
  'border-radius',
  ...[
    'top-left',
    'top-right',
    'bottom-left',
    'bottom-right',
    'start-start',
    'start-end',
    'end-start',
    'end-end',
  ].map(corner => `border-${corner}-radius`),
  ...['padding', 'margin'].flatMap(property =>
    [
      '',
      '-top',
      '-right',
      '-bottom',
      '-left',
      '-block',
      '-inline',
      '-block-start',
      '-block-end',
      '-inline-start',
      '-inline-end',
    ].map(side => property + side)
  ),
  'gap',
  'row-gap',
  'column-gap',
  ...['', 'min-', 'max-'].flatMap(prefix =>
    ['width', 'height', 'inline-size', 'block-size'].map(axis => prefix + axis)
  ),
  ...['', '-block', '-inline', '-block-start', '-block-end', '-inline-start', '-inline-end'].map(
    side => `inset${side}`
  ),
  'top',
  'right',
  'bottom',
  'left',
  'grid-template-columns',
  'grid-template-rows',
  'translate',
];

describe('arbitrary properties', () => {
  test('handles case-insensitive CSS names and relative units', () => {
    for (const utility of ['[FONT-SIZE:0.8rem]', '[padding-inline:0.1em]']) {
      expect(check(`const C = '${utility}';`)).toEqual([
        expect.stringContaining(`${utility}: use a design token`),
      ]);
    }
  });
  test.each(coveredProperties)('checks %s through source and CSS entry points', property => {
    const utility = `md:[${property}:3px]!`;
    expect(check(`const C = '${utility}';`)).toEqual([
      expect.stringContaining(`${utility}: use a design token`),
    ]);
    expect(checkSource('theme.css', `.a { @apply ${utility}; }`)).toHaveLength(1);
    expect(
      check(`// console-token-exception ${utility} -- Local layout.\nconst C = '${utility}';`)
    ).toEqual([]);
  });
  test.each(['color', 'background-color', 'line-height', 'box-shadow', '--custom'])(
    'permits out-of-scope %s',
    property => {
      expect(check(`const C = '[${property}:3px]';`)).toEqual([]);
    }
  );
});

describe('JavaScript whitespace escapes', () => {
  const separators = ['\\n', '\\r', '\\t', '\\f', '\\v', '\\u0020', '\\u{20}', '\\x20'];
  test.each(coveredUtilities)('rejects %s in every literal representation', name => {
    const utility = `${name}-[99px]`;
    for (const separator of separators) {
      for (const literal of [
        `'${utility}${separator}font-bold'`,
        `"${utility}${separator}font-bold"`,
        `\`${utility}${separator}font-bold\``,
        `\`${utility}${separator}\${other} font-bold\``,
        `\`font-bold \${other}${utility}${separator}\` `,
      ]) {
        expect(check(`const C = ${literal};`)).toEqual([
          expect.stringContaining(`fixture.tsx:1: ${utility}: use a design token`),
        ]);
      }
    }
  });
  test('retains physical exception positions and respects escaped backslashes', () => {
    expect(
      check(
        '// console-token-exception text-[12px] -- Local layout.\nconst C = "escaped\\ntext-[12px]";'
      )
    ).toEqual([]);
    expect(check('const C = "text-[12px]\\\\nfont-bold";')).toEqual([]);
    expect(check('const C = "text-[12px]\\\nfont-bold";')).toEqual([]);
    expect(check('const C = `font-bold\ntext-[12px]`;')[0]).toContain(
      'fixture.tsx:2: text-[12px]: use a design token'
    );
  });
});

describe('exact adjacent exceptions', () => {
  const directive = '// console-token-exception md:w-[calc(50%-4px)] -- Local segment width.';
  const literal = "const C = 'md:w-[calc(50%-4px)]';";
  test('allows only the named candidate on the next line', () => {
    expect(check(`${directive}\n${literal}`)).toEqual([]);
    expect(check(`${directive.replace('//', '/*')} */\n${literal}`)).toEqual([]);
    expect(check(`${directive}\nconst C = 'md:w-[calc(50%-4px)] text-[12px]';`)).toHaveLength(1);
  });
  test.each([
    `${directive}\n\n${literal}`,
    `${directive.replace('md:', '')}\n${literal}`,
    `// console-token-exception * -- Everything.\n${literal}`,
    `// console-token-exception md:w-[calc(50%-4px)] -- \n${literal}`,
    `/* console-token-exception md:w-[calc(50%-4px)] --\n Local width. */\n${literal}`,
    `const fake = ${JSON.stringify(directive)};\n${literal}`,
    `const fake = \`\n${directive}\n\`;\n${literal}`,
    `${directive}\n<div\n className="md:w-[calc(50%-4px)]" />`,
  ])('refuses malformed, non-comment, nonadjacent or mismatched directives: %s', source => {
    expect(check(source).length).toBeGreaterThan(0);
    expect(check(source).some(failure => failure.includes('use a design token'))).toBe(true);
  });
  test('reports stale directives and preserves physical positions through escaped strings', () => {
    expect(check(`${directive}\nconst C = 'w-12';`)[0]).toContain('unmatched');
    expect(
      check('// console-token-exception text-[12px] -- Fixture.\nconst C = `\ntext-[12px]`;').some(
        failure => failure.includes('fixture.tsx:3:')
      )
    ).toBe(true);
  });
});

describe('theme-owned documentation and repository entry point', () => {
  test('derives utilities and formulas from CSS, including changed values', () => {
    expect(renderTokenDocs(theme)).toContain('| `text-console-12` | `12px` |');
    expect(renderTokenDocs(theme)).toContain('| `rounded-sm` | `calc(var(--radius) - 4px)` |');
    expect(renderTokenDocs(theme.replace('12px', '13px'))).toContain(
      '| `text-console-12` | `13px` |'
    );
    expect(() => updateTokenDocs('missing', theme)).toThrow('markers');
  });
  test('discovers untracked source and checks drift without a source baseline', () => {
    const root = roots(mkdtempSync(join(tmpdir(), 'console-tokens-')));
    function write(file: string, text: string): void {
      const path = join(root, file);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, text);
    }
    write('packages/web/src/index.css', theme);
    write('packages/docs-web/src/content/docs/brand/index.md', guide);
    write(
      'packages/web/src/experiments/console/new/Untracked.tsx',
      '<div className="text-[12.25px]" />'
    );
    expect(checkRepository(root)).toHaveLength(2);
    expect(checkRepository(root, true)).toEqual([]);
    expect(checkRepository(root)[0]).toContain('Untracked.tsx:1: text-[12.25px]');
    write(
      'packages/web/src/experiments/console/new/Untracked.tsx',
      '<div className="text-console-12" />'
    );
    expect(checkRepository(root)).toEqual([]);
  });
});
