import { describe, expect, it } from 'vitest';
import { OUTCOMES_1X2, mapOutcomeLabel, marketKey } from './market.js';

describe('marketKey', () => {
  it('builds a stable colon-joined key', () => {
    const key = marketKey({
      fixtureId: 17588227,
      superOddsType: 'StablePrice',
      marketPeriod: 'FT',
      marketParameters: '',
    });
    expect(key).toBe('17588227:StablePrice:FT:');
  });
});

describe('mapOutcomeLabel', () => {
  it('maps numeric 1X2 labels', () => {
    expect(mapOutcomeLabel('1')).toBe('home');
    expect(mapOutcomeLabel('X')).toBe('draw');
    expect(mapOutcomeLabel('2')).toBe('away');
  });

  it('maps word labels case-insensitively and trims whitespace', () => {
    expect(mapOutcomeLabel('Home')).toBe('home');
    expect(mapOutcomeLabel(' draw ')).toBe('draw');
    expect(mapOutcomeLabel('AWAY')).toBe('away');
  });

  it('maps unknown labels to other', () => {
    expect(mapOutcomeLabel('over')).toBe('other');
    expect(mapOutcomeLabel('')).toBe('other');
  });
});

describe('OUTCOMES_1X2', () => {
  it('is home, draw, away in canonical order', () => {
    expect(OUTCOMES_1X2).toEqual(['home', 'draw', 'away']);
  });
});
