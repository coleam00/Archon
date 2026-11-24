import { afterAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Scale } from 'lucide-react';
import {
  DefinitionGrid,
  DocumentColumns,
  HeaderBand,
  IdTag,
  Panel,
  SectionHeading,
  StatChip,
} from './document';
import { documentPageProblems } from './document.test-helpers';

const dom = new Window();
afterAll(async () => {
  await dom.happyDOM.close();
});

function render(element: ReactElement): HTMLElement {
  const root = dom.document.createElement('div');
  root.innerHTML = renderToStaticMarkup(element);
  return root as unknown as HTMLElement;
}

/** A value no word break can split: it must be allowed to break anywhere. */
const UNBROKEN = 'x'.repeat(300);
const wraps = (el: Element | null | undefined): boolean =>
  el !== null &&
  el !== undefined &&
  (el.classList.contains('break-all') || el.classList.contains('[overflow-wrap:anywhere]'));

describe('Panel', () => {
  test('is a filled box, an inset one a shade darker, never an outline alone', () => {
    const page = render(
      <Panel>
        <Panel inset>row</Panel>
      </Panel>
    );
    const [outer, inner] = page.querySelectorAll('[data-doc-panel]');
    expect(outer?.getAttribute('data-doc-panel')).toBe('panel');
    expect(outer?.classList.contains('bg-surface-elevated')).toBe(true);
    expect(outer?.classList.contains('rounded-console-12')).toBe(true);
    expect(inner?.getAttribute('data-doc-panel')).toBe('inset');
    expect(inner?.classList.contains('bg-surface-inset')).toBe(true);
  });

  test('a tone reaches the DOM as a token, and draws its bar on the edge asked for', () => {
    const page = render(
      <Panel as="li" tone="var(--node-wait)" bar="left">
        content
      </Panel>
    );
    const panel = page.querySelector('li[data-doc-panel]');
    expect(panel?.getAttribute('style')).toContain('--doc-tone:var(--node-wait)');
    // The bar is painted with the tone, not merely given it.
    expect(panel?.querySelector('[data-doc-bar="left"]')?.className).toContain('var(--doc-tone)');
    // No bar without one asked for.
    expect(
      render(<Panel tone="var(--node-wait)">c</Panel>).querySelector('[data-doc-bar]')
    ).toBeNull();
  });

  test('its content may be long and unbroken without widening it', () => {
    const panel = render(<Panel>{UNBROKEN}</Panel>).querySelector('[data-doc-panel]');
    expect(panel?.classList.contains('min-w-0')).toBe(true);
    expect(wraps(panel)).toBe(true);
  });
});

describe('SectionHeading', () => {
  test('renders the icon and eyebrow in its tone, the title, the count and the action', () => {
    const page = render(
      <SectionHeading
        id="held"
        icon={Scale}
        eyebrow="Policies"
        title="What work is held to"
        tone="var(--node-wait)"
        count={9}
        action={<a href="/x">All</a>}
      />
    );
    const heading = page.querySelector('[data-doc-heading]');
    expect(heading?.getAttribute('style')).toContain('--doc-tone:var(--node-wait)');
    expect(heading?.querySelector('svg')).not.toBeNull();
    // The eyebrow (and the icon inside it) is painted with the tone.
    const eyebrow = heading?.querySelector('span');
    expect(eyebrow?.textContent).toBe('Policies');
    expect(eyebrow?.className).toContain('var(--doc-tone)');
    expect(heading?.querySelector('h2#held')?.textContent).toBe('What work is held to');
    expect(heading?.textContent).toContain('9');
    expect(heading?.querySelector('a')?.textContent).toBe('All');
  });

  test('the count and the action are optional', () => {
    const heading = render(
      <SectionHeading icon={Scale} eyebrow="Policies" title="Held" tone="var(--node-wait)" />
    ).querySelector('[data-doc-heading]');
    expect(heading?.textContent).toBe('PoliciesHeld');
  });
});

describe('HeaderBand and StatChip', () => {
  test('the band is a panel with its title, sentence and chips', () => {
    const page = render(
      <HeaderBand
        title="How web has set up its factory"
        sentence="Every setting, grouped."
        chips={[
          <StatChip key="a" figure={14} label="settings" />,
          <StatChip key="b" figure={3} label="shadows today" state="shadow" />,
        ]}
        aside={<nav aria-label="Project">web</nav>}
      />
    );
    const band = page.querySelector('[data-doc-panel="panel"]');
    expect(band?.querySelector('h2')?.textContent).toBe('How web has set up its factory');
    expect(band?.querySelector('p')?.textContent).toBe('Every setting, grouped.');
    expect([...page.querySelectorAll('[data-stat-chip]')].map(chip => chip.textContent)).toEqual([
      '14settings',
      '3shadows today',
    ]);
    expect(band?.querySelector('nav[aria-label="Project"]')).not.toBeNull();
  });

  test("a chip's state colour is a token: rule 5's state on its soft fill, rule 10's shadow", () => {
    const chip = (state?: 'failed' | 'shadow') =>
      render(<StatChip figure={1} label="x" state={state} />).querySelector('[data-stat-chip]');
    expect(chip()?.getAttribute('data-stat-chip')).toBe('neutral');
    expect(chip('failed')?.className).toContain('bg-[color:var(--error-soft)]');
    expect(chip('shadow')?.className).toContain('text-[color:var(--node-opaque)]');
    expect(chip('shadow')?.className).not.toContain('bg-');
  });
});

describe('DefinitionGrid', () => {
  test('one row per fact, label and value side by side, and a long unbroken value wraps', () => {
    const page = render(
      <DefinitionGrid
        rows={[
          { key: 'a', label: 'Model', value: 'opus' },
          { key: 'b', label: 'Path', value: UNBROKEN },
        ]}
      />
    );
    const rows = [...page.querySelectorAll('dl > div')];
    expect(rows.map(row => row.querySelector('dt')?.textContent)).toEqual(['Model', 'Path']);
    expect(rows[1]?.querySelector('dd')?.textContent).toBe(UNBROKEN);
    expect(wraps(rows[1]?.querySelector('dd'))).toBe(true);
    // console-token-exception sm:grid-cols-[160px_1fr] -- the label column owner change 5 asks for, as DefinitionGrid writes it.
    expect(page.querySelector('dl')?.className).toContain('sm:grid-cols-[160px_1fr]');
  });
});

describe('IdTag', () => {
  test('is a small mono tag, and a long id wraps', () => {
    const tag = render(<IdTag id={UNBROKEN} />).querySelector('[data-id-tag]');
    expect(tag?.textContent).toBe(UNBROKEN);
    expect(tag?.classList.contains('font-mono')).toBe(true);
    expect(wraps(tag)).toBe(true);
  });
});

describe('documentPageProblems', () => {
  const section = (heading: boolean) => (
    <section data-doc-section="">
      {heading ? (
        <SectionHeading icon={Scale} eyebrow="E" title="T" tone="var(--node-wait)" />
      ) : null}
      <ul>
        <Panel as="li">a</Panel>
      </ul>
    </section>
  );

  test('passes a page of panels and headed sections', () => {
    const page = render(
      <div data-doc-page="">
        <Panel>band</Panel>
        {section(true)}
      </div>
    );
    expect(documentPageProblems(page)).toEqual([]);
  });

  test('finds a section with no heading row, a bare box, and an outline-only box', () => {
    const page = render(
      <div data-doc-page="">
        {section(false)}
        <p>loose text</p>
        <Panel>
          <div className="rounded-console-12 border border-border">outline</div>
        </Panel>
      </div>
    );
    expect(documentPageProblems(page)).toEqual([
      'section 0 does not open with a heading row',
      'top-level box 1 <p> is no panel or section',
      'outline-only box <div class="rounded-console-12 border border-border">',
    ]);
  });

  test('looks into a main column and aside: headed sections pass, a bare box does not', () => {
    const page = render(
      <div data-doc-page="">
        <DocumentColumns
          main={
            <>
              {section(true)}
              <p>loose text</p>
            </>
          }
          aside={<Panel>facts</Panel>}
          asideLabel="About"
        />
      </div>
    );
    expect(documentPageProblems(page)).toEqual([
      'column 0 of box 0: top-level box 1 <p> is no panel or section',
    ]);
  });

  test('a page with no body is reported', () => {
    expect(documentPageProblems(render(<Panel>x</Panel>))).toEqual([
      'expected one [data-doc-page], found 0',
    ]);
  });
});
