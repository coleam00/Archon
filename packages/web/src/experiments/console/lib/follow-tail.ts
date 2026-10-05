export function followTail(
  viewport: Pick<HTMLElement, 'scrollTop' | 'scrollHeight'> | null,
  following: boolean
): void {
  if (viewport !== null && following) viewport.scrollTop = viewport.scrollHeight;
}
