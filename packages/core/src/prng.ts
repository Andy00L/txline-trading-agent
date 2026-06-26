/**
 * A deterministic pseudo-random source in [0, 1). Injected so backoff jitter and any
 * sampling stay reproducible; core never calls the global random generator.
 * sourceRef: docs/BUILD_PLAN.md ("inject a Clock and seeded PRNG").
 */
export interface Prng {
  next(): number;
}

/**
 * mulberry32: a small, fast, well-distributed seeded generator. Deterministic given
 * the seed, so a recorded run replays identically.
 * sourceRef: Tommy Ettinger's mulberry32 (public domain).
 */
export class SeededPrng implements Prng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let mixed = this.state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    // Scale the 32-bit result into [0, 1) by dividing by 2^32.
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  }
}
