import { describe, expect, it } from 'vitest';
import {
  formatClv,
  formatOdds,
  formatPnl,
  formatProbPct,
  formatUsd,
  isNegativeMicro,
  outcomeLabel,
  predicateForOutcome,
  shortenHash,
  shortenSig,
} from './format';

describe('formatUsd', () => {
  it('formats micro-USD with thousands separators and two decimals', () => {
    expect(formatUsd('1000000000')).toBe('$1,000.00');
    expect(formatUsd('1500000')).toBe('$1.50');
  });

  it('stays exact for a value beyond 2^53 micro-USD (no float drift)', () => {
    // 10_000_000_000 USD = 1e16 micro, above Number.MAX_SAFE_INTEGER (~9.007e15).
    expect(formatUsd('10000000000000000')).toBe('$10,000,000,000.00');
  });

  it('returns the raw input when it is not a valid bigint', () => {
    expect(formatUsd('not-a-number')).toBe('not-a-number');
  });
});

describe('formatPnl', () => {
  it('signs the value and truncates to the cent', () => {
    expect(formatPnl('26000000')).toBe('+$26.00');
    expect(formatPnl('-25000000')).toBe('-$25.00');
    expect(formatPnl('0')).toBe('+$0.00');
  });
});

describe('isNegativeMicro', () => {
  it('detects a negative micro string and tolerates a malformed one', () => {
    expect(isNegativeMicro('-1')).toBe(true);
    expect(isNegativeMicro('1')).toBe(false);
    expect(isNegativeMicro('x')).toBe(false);
  });
});

describe('other formatters', () => {
  it('formats probability, odds, and CLV', () => {
    expect(formatProbPct(0.52632)).toBe('52.6%');
    expect(formatOdds(2100)).toBe('2.100');
    expect(formatClv(0.0123)).toBe('+1.23pp');
    expect(formatClv(-0.02)).toBe('-2.00pp');
  });

  it('shortens a long signature and labels an outcome', () => {
    expect(shortenSig('abcdefghijklmnop')).toBe('abcdef…klmnop');
    expect(shortenSig('short')).toBe('short');
    expect(outcomeLabel('home')).toBe('Home');
    expect(outcomeLabel('unknown')).toBe('unknown');
  });
});

describe('shortenHash and predicateForOutcome', () => {
  it('shortens a 64-char commit hash and leaves a short one intact', () => {
    expect(shortenHash('ab'.repeat(32))).toBe('ababababab…abababab');
    expect(shortenHash('deadbeef')).toBe('deadbeef');
  });

  it('maps a committed outcome to the on-chain 1X2 predicate', () => {
    expect(predicateForOutcome('home')).toBe('participant1 - participant2 goals > 0');
    expect(predicateForOutcome('draw')).toBe('participant1 - participant2 goals == 0');
    expect(predicateForOutcome('away')).toBe('participant1 - participant2 goals < 0');
    expect(predicateForOutcome('other')).toBe('participant goal difference');
  });
});
