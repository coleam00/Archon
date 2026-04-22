import { useState, type ReactNode } from 'react';
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

/**
 * Optional free-text input rendered below the description. Used for the
 * reject flow so reviewers can attach a reason that propagates to the
 * workflow's `on_reject` prompt as `$REJECTION_REASON`.
 */
interface ReasonInputConfig {
  label: string;
  placeholder?: string;
}

interface Props {
  /** The element that opens the dialog when clicked (typically a button). */
  trigger: ReactNode;
  /** Dialog title (e.g. "Abandon workflow?"). */
  title: string;
  /** Body text — supports rich children (e.g. wrapping the workflow name in <strong>). */
  description: ReactNode;
  /** Confirm-button label (e.g. "Abandon", "Delete"). */
  confirmLabel: string;
  /**
   * When provided, renders a textarea below the description. The trimmed
   * value is passed to `onConfirm` — empty after trim becomes `undefined`
   * so callers can distinguish "no reason given" from "empty string given".
   */
  reasonInput?: ReasonInputConfig;
  /** Invoked when the user confirms. Fire-and-forget; callers own error
   *  surfacing. Widen to `Promise<void>` only if a future caller needs to
   *  await the action. `reason` is only non-`undefined` when `reasonInput`
   *  is supplied and the user typed something after trimming. */
  onConfirm: (reason?: string) => void;
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
 * For reject flows, pass `reasonInput` to collect a trimmed free-text reason
 * that propagates to `$REJECTION_REASON` inside the workflow's `on_reject`
 * prompt.
 *
 * Replaces previous use of `window.confirm()` for these actions to match the
 * codebase-delete UX in `sidebar/ProjectSelector.tsx`.
 */
export function ConfirmRunActionDialog({
  trigger,
  title,
  description,
  confirmLabel,
  reasonInput,
  onConfirm,
}: Props): React.ReactElement {
  const [reason, setReason] = useState('');

  return (
    <AlertDialog
      onOpenChange={(open): void => {
        // Reset the textarea every time the dialog closes so a previous
        // reason doesn't bleed into the next reject action on the same card.
        if (!open) setReason('');
      }}
    >
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {reasonInput && (
          <div className="space-y-2">
            <label
              htmlFor="confirm-run-action-reason"
              className="text-sm font-medium text-foreground"
            >
              {reasonInput.label}
            </label>
            <textarea
              id="confirm-run-action-reason"
              value={reason}
              onChange={(e): void => {
                setReason(e.target.value);
              }}
              placeholder={reasonInput.placeholder}
              rows={3}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(): void => {
              // Caller's onConfirm is fire-and-forget over a parent-level
              // runAction helper that surfaces errors via component state.
              // We do NOT catch here; swallowing would hide failures the
              // parent is positioned to display.
              const trimmed = reason.trim();
              onConfirm(trimmed === '' ? undefined : trimmed);
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
