import { useCallback } from 'react';
import { useSearchParams } from 'react-router';

/**
 * Bookmarkable run-drawer state. The currently-open run id is encoded as a
 * `?run=<id>` query param so reload + share preserves drawer state.
 *
 * Co-exists with the `?tab=…` param the MissionPage tabs already use; setters
 * preserve unrelated params on every write.
 */
export function useDrawerHash(): {
  openRunId: string | null;
  openRun: (id: string) => void;
  closeRun: () => void;
} {
  const [searchParams, setSearchParams] = useSearchParams();
  const openRunId = searchParams.get('run');

  const openRun = useCallback(
    (id: string) => {
      setSearchParams(
        prev => {
          const next = new URLSearchParams(prev);
          next.set('run', id);
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const closeRun = useCallback(() => {
    setSearchParams(
      prev => {
        const next = new URLSearchParams(prev);
        next.delete('run');
        return next;
      },
      { replace: true }
    );
  }, [setSearchParams]);

  return { openRunId, openRun, closeRun };
}
