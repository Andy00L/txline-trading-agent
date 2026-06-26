import { describe, expect, it } from 'vitest';
import type { Fixture } from '../schemas/fixtures.js';
import type { OddsPayload } from '../schemas/odds.js';
import type { ScoresPayload } from '../schemas/scores.js';
import { mapFixturePayload, mapOddsPayload, mapScorePayload } from './index.js';

const baseOdds: OddsPayload = {
  FixtureId: 17588227,
  MessageId: '1750000000000:0',
  Ts: 1750000000000,
  Bookmaker: 'TXLineStablePriceDemargined',
  BookmakerId: 0,
  SuperOddsType: '1X2_PARTICIPANT_RESULT',
  InRunning: false,
  MarketPeriod: 'FT',
  MarketParameters: '',
  PriceNames: ['1', 'X', '2'],
  Prices: [2100, 3400, 3600],
  Pct: ['47.619', '29.412', '27.778'],
};

const baseScore: ScoresPayload = {
  FixtureId: 17588227,
  GameState: 'F',
  Participant1IsHome: true,
  Ts: 1750000300000,
  Seq: 401,
  Stats: { '1': 2, '2': 1 },
};

const baseFixture: Fixture = {
  FixtureId: 17588227,
  Ts: 1749900000000,
  StartTime: 1750000000000,
  Competition: 'World Cup > Group Stage',
  CompetitionId: 12345,
  FixtureGroupId: 1,
  Participant1Id: 111,
  Participant1: 'Mexico',
  Participant2Id: 222,
  Participant2: 'South Africa',
  Participant1IsHome: true,
};

describe('mapOddsPayload', () => {
  it('maps a 1X2 odds payload into lines and a market key', () => {
    const result = mapOddsPayload(baseOdds);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const update = result.value;
      expect(update.fixtureId).toBe(17588227);
      expect(update.marketKey).toBe('17588227:1X2_PARTICIPANT_RESULT:FT:');
      expect(update.lines).toHaveLength(3);
      expect(update.lines[0]?.outcome).toBe('home');
      expect(update.lines[0]?.decimalOddsMilli).toBe(2100);
      expect(update.lines[0]?.impliedPct).toBeCloseTo(0.47619, 6);
      expect(update.lines[1]?.outcome).toBe('draw');
      expect(update.lines[2]?.outcome).toBe('away');
    }
  });

  it('maps the live part1/draw/part2 1X2 labels to home/draw/away', () => {
    const result = mapOddsPayload({ ...baseOdds, PriceNames: ['part1', 'draw', 'part2'] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.lines[0]?.outcome).toBe('home');
      expect(result.value.lines[1]?.outcome).toBe('draw');
      expect(result.value.lines[2]?.outcome).toBe('away');
    }
  });

  it('leaves non-1X2 markets (handicap, over/under) as other so the 1X2 strategy ignores them', () => {
    const result = mapOddsPayload({
      ...baseOdds,
      SuperOddsType: 'ASIANHANDICAP_PARTICIPANT_GOALS',
      PriceNames: ['part1', 'part2'],
      Prices: [2177, 1850],
      Pct: ['NA', 'NA'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.lines.every((line) => line.outcome === 'other')).toBe(true);
    }
  });

  it('maps NA in Pct to a null implied probability', () => {
    const result = mapOddsPayload({ ...baseOdds, Pct: ['NA', '29.412', '27.778'] });
    if (result.ok) {
      expect(result.value.lines[0]?.impliedPct).toBeNull();
    }
  });

  it('errors on a price that is not valid decimal odds', () => {
    const result = mapOddsPayload({ ...baseOdds, Prices: [1000, 3400, 3600] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid-odds');
    }
  });

  it('errors when PriceNames and Prices lengths differ', () => {
    const result = mapOddsPayload({ ...baseOdds, Prices: [2100, 3400] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('odds-array-mismatch');
    }
  });
});

describe('mapScorePayload', () => {
  it('derives home and away goals when participant 1 is home', () => {
    const result = mapScorePayload(baseScore);
    if (result.ok) {
      expect(result.value.homeGoals).toBe(2);
      expect(result.value.awayGoals).toBe(1);
      expect(result.value.stats.get(1)).toBe(2);
    }
  });

  it('keeps home as participant 1 regardless of participant1IsHome (participant-space)', () => {
    // No flip: the on-chain settle proof is participant-indexed, so home goals are always
    // participant 1 goals even when participant1IsHome is false. sourceRef: docs/audit/M8-audit.md.
    const result = mapScorePayload({ ...baseScore, Participant1IsHome: false });
    if (result.ok) {
      expect(result.value.homeGoals).toBe(2);
      expect(result.value.awayGoals).toBe(1);
      expect(result.value.participant1IsHome).toBe(false);
    }
  });

  it('returns null goals when the goal stats are absent', () => {
    const result = mapScorePayload({ ...baseScore, Stats: {} });
    if (result.ok) {
      expect(result.value.homeGoals).toBeNull();
      expect(result.value.awayGoals).toBeNull();
    }
  });
});

describe('mapFixturePayload', () => {
  it('maps a fixture record', () => {
    const result = mapFixturePayload(baseFixture);
    if (result.ok) {
      expect(result.value.participant1).toBe('Mexico');
      expect(result.value.participant2).toBe('South Africa');
      expect(result.value.startTimeMs).toBe(1750000000000);
      expect(result.value.participant1IsHome).toBe(true);
    }
  });
});
