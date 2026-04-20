import type { ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { t } from '@/lib/i18n';

interface Props {
  /** The element that opens the dialog when clicked (typically a button). */
  trigger: ReactNode;
  /** Dialog title (e.g. "Abandon workflow?"). */
  title: string;
  /** Body text — supports rich children (e.g. wrapping the workflow name in <strong>). */
  description: ReactNode;
  /** Confirm-button label (e.g. "Abandon", "Delete"). */
  confirmLabel: string;
  /** Invoked when the user confirms. The current callsites are all
   *  fire-and-forget wrappers around React Query mutations whose error
   *  handling lives at the page level (`runAction` in `DashboardPage.tsx`).
   *  Widen to `Promise<void>` only if a caller needs to await the action. */
  onConfirm: () => void;
}

/**
 * Confirmation dialog for destructive workflow-run actions.
 *
 * Wraps shadcn's AlertDialog with the trigger included as a slot, so callers
 * pass their existing action button as the `trigger` prop. The Action button
 * is destructive-styled by default (per `AlertDialogAction` in
 * `@/components/ui/alert-dialog`), which is appropriate for every workflow
 * lifecycle action this is used for (Abandon, Cancel, Delete, Reject).
 *
 * Replaces previous use of `window.confirm()` for these actions to match the
 * codebase-delete UX in `sidebar/ProjectSelector.tsx`.
 */
export function ConfirmRunActionDialog({
  trigger,
  title,
  description,
  confirmLabel,
  onConfirm,
}: Props): React.ReactElement {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(): void => {
              // Caller's onConfirm is fire-and-forget over a parent-level
              // runAction helper that surfaces errors via component state.
              // We do NOT catch here; swallowing would hide failures the
              // parent is positioned to display.
              onConfirm();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
