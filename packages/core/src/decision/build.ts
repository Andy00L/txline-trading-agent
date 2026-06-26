import type { Decision } from '../domain/decision.js';
import type { QuantError } from '../quant/error.js';
import { kellyStake, type KellyConfig } from '../quant/kelly.js';
import { steamStake, type SteamSizingConfig } from '../quant/sizing.js';
import { ok, type Result } from '../result.js';
import { evaluate } from '../risk/manager.js';
import type { RiskConfig, RiskContext, RiskState } from '../risk/types.js';
import type { Signal } from '../signal/types.js';

export type DecisionConfig = {
  readonly kelly: KellyConfig;
  readonly risk: RiskConfig;
  /** When set, steam signals are sized by this CLV-first rule instead of Kelly, because
   * the de-margined consensus line gives Kelly no edge. Divergence still uses Kelly. */
  readonly steamSizing?: SteamSizingConfig;
};

export type DecisionOutcome =
  | { readonly kind: 'decision'; readonly decision: Decision }
  | { readonly kind: 'skipped'; readonly reason: 'no-edge' | 'risk-blocked'; readonly detail: string };

export type BuildDecisionInput = {
  readonly signal: Signal;
  readonly riskState: RiskState;
  readonly riskContext: RiskContext;
  readonly nowMs: number;
  readonly feedTsMs: number;
};

/**
 * Turn a detected signal into a sized, risk-approved decision, or a reason it was
 * skipped. Pure: it sizes with fractional Kelly against the current bankroll, then
 * runs the risk manager (which may reduce the stake to fit caps or block it). The
 * only error is a malformed Kelly config; a zero stake or a tripped breaker is a
 * legitimate skip, not an error.
 */
export const buildDecision = (
  input: BuildDecisionInput,
  config: DecisionConfig,
): Result<DecisionOutcome, QuantError> => {
  const stakeResult =
    input.signal.kind === 'steam' && config.steamSizing !== undefined
      ? steamStake(input.signal.strength, input.riskState.bankroll, config.steamSizing)
      : kellyStake(
          input.signal.fairProb,
          input.signal.offeredOddsMilli,
          input.riskState.bankroll,
          config.kelly,
        );
  if (!stakeResult.ok) {
    return stakeResult;
  }
  if (stakeResult.value <= 0n) {
    return ok({ kind: 'skipped', reason: 'no-edge', detail: 'Kelly stake quantized to zero' });
  }

  const verdict = evaluate(
    input.riskState,
    {
      proposedStake: stakeResult.value,
      offeredOddsMilli: input.signal.offeredOddsMilli,
      fixtureId: input.signal.fixtureId,
      marketKey: input.signal.marketKey,
      nowMs: input.nowMs,
      feedTsMs: input.feedTsMs,
      context: input.riskContext,
    },
    config.risk,
  );
  if (!verdict.allowed) {
    return ok({ kind: 'skipped', reason: 'risk-blocked', detail: verdict.reason });
  }

  return ok({
    kind: 'decision',
    decision: {
      fixtureId: input.signal.fixtureId,
      marketKey: input.signal.marketKey,
      outcome: input.signal.outcome,
      tsMs: input.signal.tsMs,
      signalKind: input.signal.kind,
      fairProb: input.signal.fairProb,
      entryOddsMilli: input.signal.offeredOddsMilli,
      stake: verdict.stake,
      edge: input.signal.edge,
    },
  });
};
