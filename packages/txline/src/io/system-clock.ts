import type { Clock } from '@txline-agent/core';

/** Production clock backed by the system wall clock. The decision path never reads
 * it directly; only the live runtime injects this. */
export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }
}
