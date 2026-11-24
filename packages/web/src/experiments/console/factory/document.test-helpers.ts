/**
 * Holds a rendered document page to owner change 5 of 2026-11-21 (`document.tsx`): every
 * top-level box of the page body (`[data-doc-page]`) is a filled `Panel` or a section that
 * opens with a `SectionHeading` and holds only panels, and nothing under it is an outline-only
 * box on the page colour. The step page, the item page and Needs you use this too.
 */

/** Boxes drawn as an outline with no fill of their own: a border and a console radius, no `bg-`. */
export function outlineBoxes(root: Element): string[] {
  return [...root.querySelectorAll('*')]
    .filter(el => {
      // An inline badge (a span) is a mark on its line, not a box.
      if (el.tagName === 'SPAN') return false;
      const classes = [...el.classList];
      return (
        classes.includes('border') &&
        classes.some(name => name.startsWith('rounded-console-')) &&
        !classes.some(name => name.startsWith('bg-'))
      );
    })
    .map(el => `outline-only box <${el.tagName.toLowerCase()} class="${el.className}">`);
}

const isPanel = (el: Element): boolean => el.getAttribute('data-doc-panel') === 'panel';

/** What on the page breaks owner change 5; empty when it holds. */
export function documentPageProblems(root: Element): string[] {
  const pages = root.querySelectorAll('[data-doc-page]');
  if (pages.length !== 1) return [`expected one [data-doc-page], found ${pages.length}`];
  const boxes = [...(pages[0]?.children ?? [])];
  return [...boxes.flatMap(boxProblems), ...outlineBoxes(root)];
}

/**
 * A top-level box is a panel, a section that opens with a heading row and holds panels, or a
 * `DocumentColumns` box whose two columns each hold only such panels and sections.
 */
function boxProblems(box: Element, index: number): string[] {
  if (isPanel(box)) return [];
  if (box.hasAttribute('data-doc-columns'))
    return [...box.children].flatMap((column, c) =>
      [...column.children].flatMap((inner, i) =>
        boxProblems(inner, i).map(problem => `column ${c} of box ${index}: ${problem}`)
      )
    );
  if (!box.hasAttribute('data-doc-section'))
    return [`top-level box ${index} <${box.tagName.toLowerCase()}> is no panel or section`];
  const children = [...box.children];
  const headed = children[0]?.hasAttribute('data-doc-heading') === true;
  const held = headed ? children.slice(1) : children;
  const problems: string[] = [];
  if (!headed) problems.push(`section ${index} does not open with a heading row`);
  if (held.length === 0) problems.push(`section ${index} holds nothing under its heading`);
  if (!held.every(holdsPanels)) problems.push(`section ${index} holds a box that is not a panel`);
  return problems;
}

/** A section holds panels, directly or as the items of one grid. */
const holdsPanels = (child: Element): boolean =>
  isPanel(child) || (child.children.length > 0 && [...child.children].every(isPanel));
