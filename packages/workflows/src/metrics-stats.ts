/**
 * Two-sided 95% intervals for metric aggregates and for the difference between two
 * groups. Pure functions; callers decide when a sample is too small to report one.
 */

export interface Interval {
  low: number;
  high: number;
}

/** A 0/1 sample: `successes` of `n`. */
export interface RateSample {
  successes: number;
  n: number;
}

/** The standard normal 0.975 quantile. */
const Z = 1.959963984540054;

/** Wilson score interval for a proportion; `n` must be positive. */
export function wilsonInterval(successes: number, n: number): Interval {
  const p = successes / n;
  const z2 = Z * Z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const half = (Z / denominator) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

/** mean ± t(0.975, n−1) · s / √n; `values` needs at least two entries. */
export function meanInterval(values: readonly number[]): Interval {
  const { mean, variance } = moments(values);
  const half = tQuantile975(values.length - 1) * Math.sqrt(variance / values.length);
  return { low: mean - half, high: mean + half };
}

/**
 * Newcombe's hybrid score interval (method 10 of Newcombe 1998) for the difference of
 * proportions `a − b`, built from each side's Wilson interval.
 */
export function newcombeDifference(a: RateSample, b: RateSample): Interval {
  const p1 = a.successes / a.n;
  const p2 = b.successes / b.n;
  const w1 = wilsonInterval(a.successes, a.n);
  const w2 = wilsonInterval(b.successes, b.n);
  const delta = p1 - p2;
  return {
    low: delta - Math.hypot(p1 - w1.low, w2.high - p2),
    high: delta + Math.hypot(w1.high - p1, p2 - w2.low),
  };
}

/**
 * Welch's interval for the difference of means `a − b`, with the Welch–Satterthwaite
 * degrees of freedom. Each side needs at least two values. `null` when both sides have
 * zero variance, where the degrees of freedom are undefined.
 */
export function welchDifference(a: readonly number[], b: readonly number[]): Interval | null {
  const ma = moments(a);
  const mb = moments(b);
  const va = ma.variance / a.length;
  const vb = mb.variance / b.length;
  if (va + vb === 0) return null;
  const df = (va + vb) ** 2 / (va ** 2 / (a.length - 1) + vb ** 2 / (b.length - 1));
  const delta = ma.mean - mb.mean;
  const half = tQuantile975(df) * Math.sqrt(va + vb);
  return { low: delta - half, high: delta + half };
}

/** Sample mean and unbiased (n−1) variance. */
function moments(values: readonly number[]): { mean: number; variance: number } {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const squares = values.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  return { mean, variance: squares / (values.length - 1) };
}

/** Student's t 0.975 quantile for `df ≥ 1` degrees of freedom, not necessarily whole. */
export function tQuantile975(df: number): number {
  // The CDF is increasing in t, and the quantile is below 12.71 for every df ≥ 1.
  let low = 0;
  let high = 16;
  for (let step = 0; step < 64; step += 1) {
    const mid = (low + high) / 2;
    if (studentCdf(mid, df) < 0.975) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** P(T ≤ t) for t ≥ 0. */
function studentCdf(t: number, df: number): number {
  return 1 - 0.5 * regularizedBeta(df / (df + t * t), df / 2, 0.5);
}

/** I_x(a, b) by its continued fraction (Numerical Recipes, `betai`). */
function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x)
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betaFraction(x, a, b)) / a
    : 1 - (front * betaFraction(1 - x, b, a)) / b;
}

/** Modified Lentz evaluation of the incomplete beta continued fraction. */
function betaFraction(x: number, a: number, b: number): number {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  d = 1 / (Math.abs(d) < tiny ? tiny : d);
  let result = d;
  for (let m = 1; m <= 300; m += 1) {
    for (const numerator of [
      (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m)),
      -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1)),
    ]) {
      d = 1 + numerator * d;
      d = 1 / (Math.abs(d) < tiny ? tiny : d);
      c = 1 + numerator / c;
      if (Math.abs(c) < tiny) c = tiny;
      result *= c * d;
    }
    if (Math.abs(c * d - 1) < 1e-15) break;
  }
  return result;
}

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

/** ln Γ(x) for x > 0 (Lanczos, g = 7). */
function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const shifted = x - 1;
  let sum = LANCZOS[0] ?? 0;
  for (let i = 1; i < LANCZOS.length; i += 1) sum += (LANCZOS[i] ?? 0) / (shifted + i);
  const t = shifted + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sum);
}
