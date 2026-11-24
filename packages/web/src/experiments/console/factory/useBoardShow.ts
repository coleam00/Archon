import { useSearchParams } from 'react-router';
import {
  BOARD_SHOW,
  type BoardShow,
  type BoardShowSpec,
  parseBoardShow,
  SHOW_PARAM,
  TABLE_VIEW,
  VIEW_PARAM,
} from './lib/board-show';

interface BoardShowState {
  /** `?show=` as written; null when absent. */
  showParam: string | null;
  /** What `?show=` names; undefined when absent or unknown, and the board is then whole. */
  show: BoardShow | undefined;
  spec: BoardShowSpec | undefined;
  /** The Table, by `?view=table` or because the show opens it. */
  table: boolean;
  /** Pipeline or Table. Leaving a show's Table for the Pipeline leaves the show too. */
  setView: (next: 'pipeline' | 'table') => void;
  /** Back to every item, in the view on screen. */
  clearShow: () => void;
}

/**
 * The board's show and view, read from and written to its address, so a show is a link a person
 * can share and reload. Writes replace the history entry: a view switch is not a page.
 */
export function useBoardShow(): BoardShowState {
  const [params, setParams] = useSearchParams();
  const showParam = params.get(SHOW_PARAM);
  const show = showParam === null ? undefined : parseBoardShow(showParam);
  const spec = show === undefined ? undefined : BOARD_SHOW[show];
  const table = params.get(VIEW_PARAM) === TABLE_VIEW || spec?.table === true;
  const update = (change: (next: URLSearchParams) => void): void => {
    setParams(
      current => {
        const next = new URLSearchParams(current);
        change(next);
        return next;
      },
      { replace: true }
    );
  };
  return {
    showParam,
    show,
    spec,
    table,
    setView: next => {
      update(updated => {
        if (next === 'table') updated.set(VIEW_PARAM, TABLE_VIEW);
        else {
          updated.delete(VIEW_PARAM);
          if (spec?.table === true) updated.delete(SHOW_PARAM);
        }
      });
    },
    clearShow: () => {
      // A show that opened the Table keeps it: the person cleared the filter, not the view.
      update(updated => {
        if (spec?.table === true) updated.set(VIEW_PARAM, TABLE_VIEW);
        updated.delete(SHOW_PARAM);
      });
    },
  };
}
