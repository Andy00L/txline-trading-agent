import { describe, expect, it } from 'vitest';
import { ManualClock } from './clock.js';

describe('ManualClock', () => {
  it('returns the start time', () => {
    expect(new ManualClock(1000).nowMs()).toBe(1000);
  });

  it('advances forward with setMs and ignores backward moves', () => {
    const clock = new ManualClock(1000);
    clock.setMs(2000);
    expect(clock.nowMs()).toBe(2000);
    clock.setMs(1500);
    expect(clock.nowMs()).toBe(2000);
  });

  it('advances by a positive delta and ignores non-positive deltas', () => {
    const clock = new ManualClock(1000);
    clock.advanceMs(500);
    expect(clock.nowMs()).toBe(1500);
    clock.advanceMs(-100);
    expect(clock.nowMs()).toBe(1500);
    clock.advanceMs(0);
    expect(clock.nowMs()).toBe(1500);
  });
});
