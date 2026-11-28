/**
 * A duration as a person reads it across a room, always with its units: "45 s", "1 min",
 * "3 h 21 min", "2 d 4 h". Never a bare "01:00", which reads as a clock time beside a start.
 */
export function durationWords(durationMs: number): string {
  const seconds = Math.floor(Math.max(0, durationMs) / 1000);
  if (seconds < 60) return `${seconds.toString()} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes.toString()} min`;
  const hours = Math.floor(minutes / 60);
  const pair = (big: number, bigUnit: string, small: number, smallUnit: string): string =>
    small === 0
      ? `${big.toString()} ${bigUnit}`
      : `${big.toString()} ${bigUnit} ${small.toString()} ${smallUnit}`;
  if (hours < 24) return pair(hours, 'h', minutes % 60, 'min');
  return pair(Math.floor(hours / 24), 'd', hours % 24, 'h');
}
