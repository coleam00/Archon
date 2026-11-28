import { useEffect, useState } from 'react';

/** The current time, re-read every `intervalMs` so a relative label keeps moving. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return (): void => {
      clearInterval(timer);
    };
  }, [intervalMs]);
  return now;
}
