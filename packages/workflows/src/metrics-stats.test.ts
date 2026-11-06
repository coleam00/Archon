import { describe, expect, test } from 'bun:test';
import {
  meanInterval,
  newcombeDifference,
  tQuantile975,
  welchDifference,
  wilsonInterval,
  type Interval,
} from './metrics-stats';

const close = (actual: Interval | null, low: number, high: number): void => {
  expect(actual?.low).toBeCloseTo(low, 4);
  expect(actual?.high).toBeCloseTo(high, 4);
};

// Welch's t-test, Wikipedia, example 1: t = 2.46, ν = 25.0 for A2 − A1.
const A1 = [
  27.5, 21.0, 19.0, 23.6, 17.0, 17.9, 16.9, 20.1, 21.9, 22.6, 23.1, 19.6, 19.0, 21.7, 21.4,
];
const A2 = [
  27.1, 22.0, 20.8, 23.4, 23.4, 23.5, 25.8, 22.0, 24.8, 20.2, 21.9, 22.1, 22.9, 20.5, 24.4,
];

describe('metric intervals', () => {
  test('t quantiles match the published table, including fractional degrees of freedom', () => {
    expect(tQuantile975(1)).toBeCloseTo(12.7062, 4);
    expect(tQuantile975(2)).toBeCloseTo(4.3027, 4);
    expect(tQuantile975(10)).toBeCloseTo(2.2281, 4);
    expect(tQuantile975(30)).toBeCloseTo(2.0423, 4);
    expect(tQuantile975(24.5)).toBeCloseTo(2.0617, 4);
  });

  test('Wilson intervals match Newcombe (1998) for 0, 5 and 10 of 10 and 81 of 263', () => {
    close(wilsonInterval(0, 10), 0, 0.2775);
    close(wilsonInterval(5, 10), 0.2366, 0.7634);
    close(wilsonInterval(10, 10), 0.7225, 1);
    close(wilsonInterval(81, 263), 0.2553, 0.3662);
  });

  test("Newcombe's hybrid interval matches his worked examples", () => {
    close(newcombeDifference({ successes: 56, n: 70 }, { successes: 48, n: 80 }), 0.0524, 0.3339);
    close(newcombeDifference({ successes: 9, n: 10 }, { successes: 3, n: 10 }), 0.1705, 0.809);
  });

  test('the mean interval uses t at n − 1', () => {
    close(meanInterval(A1), 19.2667, 22.3733);
  });

  test("Welch's interval uses Welch's degrees of freedom", () => {
    close(welchDifference(A2, A1), 0.3492, 3.9841);
  });

  test('Welch has no interval when neither side varies', () => {
    expect(welchDifference([1, 1], [2, 2])).toBeNull();
  });
});
