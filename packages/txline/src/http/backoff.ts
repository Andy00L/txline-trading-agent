import type { Prng } from '@txline-agent/core';

export type BackoffConfig = {
  readonly baseMs: number; // base delay for the first retry
  readonly maxMs: number; // cap on any single delay
  readonly maxAttempts: number; // total attempts including the first try
};

export const DEFAULT_BACKOFF: BackoffConfig = { baseMs: 250, maxMs: 10_000, maxAttempts: 5 };

/**
 * Exponential backoff with full jitter: delay = uniform(0, min(maxMs, base * 2^attempt)).
 * attempt is 0-based for the first retry. Deterministic given the injected Prng.
 * sourceRef: AWS "Exponential Backoff And Jitter" (full jitter variant).
 */
export const computeBackoffMs = (attempt: number, config: BackoffConfig, prng: Prng): number => {
  const ceiling = Math.min(config.maxMs, config.baseMs * 2 ** attempt);
  return Math.floor(prng.next() * ceiling);
};
