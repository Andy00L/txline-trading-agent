import { describe, expect, it } from 'vitest';
import { parseWith } from '../parse.js';
import { oddsPayloadSchema } from './odds.js';
import { scoresPayloadSchema } from './scores.js';
import { fixtureSchema } from './fixtures.js';
import { scoresStatValidationSchema } from './proof.js';

// Synthetic but schema-valid payloads. Real captured fixtures replace these once a
// subscription token is available (see docs/research/M0-recon-findings.md).
const validOdds = {
  FixtureId: 17588227,
  MessageId: '1750000000000:0',
  Ts: 1750000000000,
  Bookmaker: 'StablePrice',
  BookmakerId: 0,
  SuperOddsType: 'StablePrice',
  InRunning: false,
  PriceNames: ['1', 'X', '2'],
  Prices: [2100, 3400, 3600],
  Pct: ['47.619', '29.412', '27.778'],
};

const validScores = {
  fixtureId: 17588227,
  gameState: 'F',
  startTime: 1750000000000,
  isTeam: true,
  fixtureGroupId: 1,
  competitionId: 12345,
  countryId: 1,
  sportId: 1,
  participant1IsHome: true,
  participant2Id: 222,
  participant1Id: 111,
  action: 'goal',
  id: 9,
  ts: 1750000300000,
  connectionId: 42,
  seq: 401,
  stats: { '1': 2, '2': 1 },
};

const validFixture = {
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

const validStatValidation = {
  ts: 1750000200000,
  statToProve: { key: 1, value: 2, period: 0 },
  eventStatRoot: 'aa'.repeat(32),
  summary: {
    fixtureId: 17588227,
    updateStats: { updateCount: 5, minTimestamp: 1750000000000, maxTimestamp: 1750000300000 },
    eventStatsSubTreeRoot: 'bb'.repeat(32),
  },
  statProof: [{ hash: 'cc'.repeat(32), isRightSibling: true }],
  subTreeProof: [{ hash: 'dd'.repeat(32), isRightSibling: false }],
  mainTreeProof: null,
  statToProve2: { key: 2, value: 1, period: 0 },
  statProof2: [{ hash: 'ee'.repeat(32), isRightSibling: true }],
};

describe('oddsPayloadSchema', () => {
  it('parses a valid odds payload', () => {
    const result = parseWith(oddsPayloadSchema, validOdds);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.FixtureId).toBe(17588227);
      expect(result.value.Prices).toEqual([2100, 3400, 3600]);
    }
  });

  it('reports the field path of a missing required key', () => {
    const result = parseWith(oddsPayloadSchema, {
      FixtureId: 17588227,
      Ts: 1750000000000,
      Bookmaker: 'StablePrice',
      BookmakerId: 0,
      SuperOddsType: 'StablePrice',
      InRunning: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe('MessageId');
    }
  });

  it('rejects a Pct that is not three decimals or NA', () => {
    const result = parseWith(oddsPayloadSchema, { ...validOdds, Pct: ['47.61'] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe('Pct.0');
    }
  });

  it('accepts NA in Pct', () => {
    const result = parseWith(oddsPayloadSchema, { ...validOdds, Pct: ['NA', '29.412', '27.778'] });
    expect(result.ok).toBe(true);
  });
});

describe('scoresPayloadSchema', () => {
  it('parses a valid scores payload', () => {
    const result = parseWith(scoresPayloadSchema, validScores);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.seq).toBe(401);
      expect(result.value.participant1IsHome).toBe(true);
    }
  });

  it('rejects a payload missing seq', () => {
    const result = parseWith(scoresPayloadSchema, { ...validScores, seq: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe('seq');
    }
  });
});

describe('fixtureSchema', () => {
  it('parses a valid fixture', () => {
    const result = parseWith(fixtureSchema, validFixture);
    expect(result.ok).toBe(true);
  });

  it('rejects a fixture missing FixtureId', () => {
    const result = parseWith(fixtureSchema, { ...validFixture, FixtureId: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe('FixtureId');
    }
  });
});

describe('scoresStatValidationSchema', () => {
  it('parses a valid two-stat proof with a null main-tree proof', () => {
    const result = parseWith(scoresStatValidationSchema, validStatValidation);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.statToProve.key).toBe(1);
      expect(result.value.statToProve2?.key).toBe(2);
      expect(result.value.mainTreeProof).toBeNull();
    }
  });

  it('rejects a proof missing mainTreeProof', () => {
    const result = parseWith(scoresStatValidationSchema, {
      ...validStatValidation,
      mainTreeProof: undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe('mainTreeProof');
    }
  });
});
