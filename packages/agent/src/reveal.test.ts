import { describe, expect, it } from 'vitest';
import {
  decimalOddsMilli,
  marketKey,
  microUsdSaturating,
  prob,
  type Decision,
  type DecimalOddsMilli,
  type MarketKey,
  type Outcome,
  type Prob,
} from '@txline-agent/core';
import { buildRevealFromDecision, SIDE_AWAY, SIDE_DRAW, SIDE_HOME } from './reveal.js';

const FIXTURE_ID = 17588302;
const MKEY: MarketKey = marketKey({
  fixtureId: FIXTURE_ID,
  superOddsType: '1X2_PARTICIPANT_RESULT',
  marketPeriod: 'FT',
  marketParameters: '',
});

const oddsMilli = (value: number): DecimalOddsMilli => {
  const result = decimalOddsMilli(value);
  if (!result.ok) {
    throw new Error(`bad odds ${value}`);
  }
  return result.value;
};

const probOf = (value: number): Prob => {
  const result = prob(value);
  if (!result.ok) {
    throw new Error(`bad prob ${value}`);
  }
  return result.value;
};

const decisionOf = (outcome: Outcome, fairProb = 0.5): Decision => ({
  fixtureId: FIXTURE_ID,
  marketKey: MKEY,
  outcome,
  tsMs: 1_000,
  signalKind: 'steam',
  fairProb: probOf(fairProb),
  entryOddsMilli: oddsMilli(2100),
  stake: microUsdSaturating(25_000_000n),
  edge: 0.02,
});

const STRATEGY = new Uint8Array(32).fill(7);
const NONCE = new Uint8Array(32).fill(9);

describe('buildRevealFromDecision', () => {
  it('maps a home decision to side 0 and copies the sealed fields verbatim', () => {
    const reveal = buildRevealFromDecision({
      decision: decisionOf('home', 0.5),
      strategyBytes: STRATEGY,
      index: 4n,
      nonce: NONCE,
    });
    expect(reveal.ok).toBe(true);
    if (!reveal.ok) {
      return;
    }
    expect(reveal.value.side).toBe(SIDE_HOME);
    expect(reveal.value.index).toBe(4n);
    expect(reveal.value.fixtureId).toBe(BigInt(FIXTURE_ID));
    expect(reveal.value.market).toBe(0);
    expect(reveal.value.fairProbBps).toBe(5000);
    expect(reveal.value.entryOddsMilli).toBe(2100);
    expect(reveal.value.stake).toBe(25_000_000n);
    expect(reveal.value.strategy).toBe(STRATEGY);
    expect(reveal.value.nonce).toBe(NONCE);
    expect(reveal.value.signalHash).toHaveLength(32);
  });

  it('maps draw to side 1 and away to side 2', () => {
    const draw = buildRevealFromDecision({
      decision: decisionOf('draw'),
      strategyBytes: STRATEGY,
      index: 0n,
      nonce: NONCE,
    });
    const away = buildRevealFromDecision({
      decision: decisionOf('away'),
      strategyBytes: STRATEGY,
      index: 0n,
      nonce: NONCE,
    });
    expect(draw.ok).toBe(true);
    expect(away.ok).toBe(true);
    if (draw.ok) {
      expect(draw.value.side).toBe(SIDE_DRAW);
    }
    if (away.ok) {
      expect(away.value.side).toBe(SIDE_AWAY);
    }
  });

  it('rounds the fair probability to basis points', () => {
    const reveal = buildRevealFromDecision({
      decision: decisionOf('home', 0.47619),
      strategyBytes: STRATEGY,
      index: 0n,
      nonce: NONCE,
    });
    expect(reveal.ok).toBe(true);
    if (reveal.ok) {
      expect(reveal.value.fairProbBps).toBe(4762);
    }
  });

  it('produces a deterministic signal hash for the same decision', () => {
    const first = buildRevealFromDecision({
      decision: decisionOf('home'),
      strategyBytes: STRATEGY,
      index: 0n,
      nonce: NONCE,
    });
    const second = buildRevealFromDecision({
      decision: decisionOf('home'),
      strategyBytes: STRATEGY,
      index: 0n,
      nonce: NONCE,
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect([...first.value.signalHash]).toEqual([...second.value.signalHash]);
    }
  });

  it('rejects a non-1X2 outcome rather than sealing a wrong side', () => {
    const reveal = buildRevealFromDecision({
      decision: decisionOf('other'),
      strategyBytes: STRATEGY,
      index: 0n,
      nonce: NONCE,
    });
    expect(reveal.ok).toBe(false);
    if (!reveal.ok) {
      expect(reveal.error.kind).toBe('unsupported-outcome');
    }
  });
});
