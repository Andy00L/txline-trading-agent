import type { SignalKind } from '../signal/types.js';
import type { DecimalOddsMilli, MicroUsd, Prob } from '../units.js';
import type { MarketKey, Outcome } from './market.js';

/**
 * A sized, risk-approved decision to back one outcome. This is the object whose
 * sealed fields (side, fair prob, entry odds, stake, signal) the on-chain commit
 * hashes before kickoff. sourceRef: docs/BUILD_PLAN.md (commit-reveal).
 */
export type Decision = {
  readonly fixtureId: number;
  readonly marketKey: MarketKey;
  readonly outcome: Outcome;
  readonly tsMs: number;
  readonly signalKind: SignalKind;
  readonly fairProb: Prob;
  readonly entryOddsMilli: DecimalOddsMilli;
  readonly stake: MicroUsd;
  readonly edge: number;
};
