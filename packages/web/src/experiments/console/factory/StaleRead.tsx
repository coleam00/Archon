import type { ReactElement } from 'react';
import { errorDetail } from '../lib/http';

/**
 * Said above values kept from an earlier read when the latest read failed (the cache keeps
 * them), so a failed refresh never passes for fresh data. Nothing when there is no error.
 */
export function StaleRead({ error }: { error: Error | undefined }): ReactElement | null {
  if (error === undefined) return null;
  return (
    <p role="status" className="text-console-12 text-warning">
      Could not refresh: {errorDetail(error)}. Showing the last values read.
    </p>
  );
}
