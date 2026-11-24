/**
 * Holds a rendered document page to owner change 5 of 2026-11-21 (`document.tsx`): every
 * top-level box of the page body (`[data-doc-page]`) is a filled `Panel` or a section that
 * opens with a `SectionHeading` and holds only panels. The step page, the item page and Needs
 * you use this too. That no box is drawn as an outline alone is a look, checked in the browser
 * (DESIGN.md, Testing): the DOM here carries no styles to read it from.
 */

const isPanel = (el: Element): boolean => el.getAttribute('data-doc-panel') === 'panel';

/** What on the page breaks owner change 5; empty when it holds. */
export function documentPageProblems(root: Element): string[] {
  const pages = root.querySelectorAll('[data-doc-page]');
  if (pages.length !== 1) return [`expected one [data-doc-page], found ${pages.length}`];
  const boxes = [...(pages[0]?.children ?? [])];
  return boxes.flatMap(boxProblems);
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
