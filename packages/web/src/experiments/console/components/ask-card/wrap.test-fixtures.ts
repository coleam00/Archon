/** A long path with no break opportunity, as item #74's forge-link option carries. */
export const LONG = `https://github.com/${'a'.repeat(40)}/blob/HEAD/${'packages/'.repeat(12)}file.ts`;

/**
 * Whether `el` wraps a long unbroken string: `overflow-wrap` inherits, so the class may sit on
 * an ancestor, as long as that ancestor is inside `box` (the card or tile it must stay in).
 * happy-dom has no layout, so this checks the wrap contract; the browser check measures pixels.
 */
export function wrapsAnywhere(el: Element, box: Element): boolean {
  const owner = el.closest('[class*="[overflow-wrap:anywhere]"]');
  return owner !== null && box.contains(owner);
}

/** The innermost elements whose text holds `text`. */
export function holding(root: Element, text: string): Element[] {
  return [...root.querySelectorAll('*')].filter(
    el =>
      el.textContent?.includes(text) === true &&
      ![...el.children].some(child => child.textContent?.includes(text) === true)
  );
}
