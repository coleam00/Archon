import { useEffect, useState } from 'react';

/**
 * The time, read again once a minute: "Merged today" turns over at midnight, and the board
 * sets an idle item aside once it crosses the line (`SET_ASIDE_IDLE_MS`), without a reload.
 */
export function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, 60_000);
    return (): void => {
      clearInterval(timer);
    };
  }, []);
  return now;
}
