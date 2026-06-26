/**
 * A source of wall-clock time in epoch milliseconds. Injected everywhere so the
 * decision path stays deterministic; core never reads the wall clock directly. The
 * live system passes a system-clock implementation (in txline/agent); replay and
 * tests pass ManualClock.
 * sourceRef: docs/BUILD_PLAN.md ("inject a Clock and seeded PRNG").
 */
export interface Clock {
  nowMs(): number;
}

/** A deterministic clock that only advances when told. Time is monotonic: backward
 * moves are ignored. Pure (it reads no system clock), so it is safe inside core. */
export class ManualClock implements Clock {
  private currentMs: number;

  constructor(startMs: number) {
    this.currentMs = startMs;
  }

  nowMs(): number {
    return this.currentMs;
  }

  /** Advance to an absolute time, ignoring backward moves. */
  setMs(absoluteMs: number): void {
    if (absoluteMs > this.currentMs) {
      this.currentMs = absoluteMs;
    }
  }

  /** Advance by a positive delta; non-positive deltas are ignored. */
  advanceMs(deltaMs: number): void {
    if (deltaMs > 0) {
      this.currentMs += deltaMs;
    }
  }
}
