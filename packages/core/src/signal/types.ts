import type { MarketKey, Outcome } from '../domain/market.js';
import type { DecimalOddsMilli, Prob } from '../units.js';

export type SignalKind = 'divergence' | 'steam' | 'cross-market';

/**
 * A detected trading signal on one outcome of one market: the consensus fair
 * probability, the odds we would take, the resulting edge (EV per unit stake), and a
 * signal-specific strength (the divergence gap, the size of the steam move, or the
 * cross-market mispricing in probability space).
 */
export type Signal = {
  readonly kind: SignalKind;
  readonly fixtureId: number;
  readonly marketKey: MarketKey;
  readonly outcome: Outcome;
  readonly tsMs: number;
  readonly fairProb: Prob;
  readonly offeredOddsMilli: DecimalOddsMilli;
  readonly edge: number;
  readonly strength: number;
};
