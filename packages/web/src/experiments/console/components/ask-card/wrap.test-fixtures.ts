/** A long path with no break opportunity, as item #74's forge-link option carries. */
export const LONG = `https://github.com/${'a'.repeat(40)}/blob/HEAD/${'packages/'.repeat(12)}file.ts`;

/** The innermost elements whose text holds `text`. */
export function holding(root: Element, text: string): Element[] {
  return [...root.querySelectorAll('*')].filter(
    el =>
      el.textContent?.includes(text) === true &&
      ![...el.children].some(child => child.textContent?.includes(text) === true)
  );
}
