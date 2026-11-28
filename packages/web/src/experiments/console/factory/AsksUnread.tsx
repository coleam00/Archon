import type { ReactElement } from 'react';
import { ReadFailure } from './ReadFailure';

/**
 * The one place a page says its asks could not be read (rule 6, #258): while the attention list
 * has never answered, every needs-you count on the page is unknown, not 0, and this says why.
 * The page draws it only when `askReadOf` is `failed`, so a failed re-read that kept its cached
 * asks says nothing.
 */
export function AsksUnread({ error, retry }: { error: Error; retry: () => void }): ReactElement {
  return (
    <div data-asks-unread>
      <ReadFailure retry={retry}>
        The asks could not be read, so nothing here shows what needs you: {error.message}
      </ReadFailure>
    </div>
  );
}
