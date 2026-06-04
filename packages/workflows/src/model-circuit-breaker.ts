/**
 * Per-run circuit breaker keyed by provider/model.
 */
export const MODEL_CIRCUIT_BREAKER_THRESHOLD = 3;

export class RunModelCircuitBreaker {
  private readonly failures = new Map<string, number>();
  private readonly open = new Set<string>();

  constructor(private readonly threshold = MODEL_CIRCUIT_BREAKER_THRESHOLD) {}

  static key(provider: string, model?: string): string {
    return `${provider}/${model ?? 'default'}`;
  }

  isOpen(provider: string, model?: string): boolean {
    return this.open.has(RunModelCircuitBreaker.key(provider, model));
  }

  recordFailure(provider: string, model?: string): void {
    const k = RunModelCircuitBreaker.key(provider, model);
    const next = (this.failures.get(k) ?? 0) + 1;
    this.failures.set(k, next);
    if (next >= this.threshold) {
      this.open.add(k);
    }
  }

  failureCount(provider: string, model?: string): number {
    return this.failures.get(RunModelCircuitBreaker.key(provider, model)) ?? 0;
  }
}

export function circuitBreakerOpenMessage(provider: string, model?: string): string {
  const path = model ? `${provider}/${model}` : provider;
  return `Circuit breaker open for ${path} (${String(MODEL_CIRCUIT_BREAKER_THRESHOLD)} failures in this run)`;
}
