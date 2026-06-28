import { err, ok, type Result } from '../result.js';
import {
  microUsdSaturating,
  ODDS_MILLI_SCALE,
  type DecimalOddsMilli,
  type MicroUsd,
  type Prob,
} from '../units.js';
import type { QuantError } from './error.js';

export type KellyConfig = {
  /** Fractional Kelly multiplier c, in (0, 1]. */
  readonly fraction: number;
  /** Hard cap on the staked fraction of bankroll, in (0, 1]. */
  readonly maxFractionOfBankroll: number;
};

/**
 * Fractional Kelly stake in integer micro-USD, clamped and quantized.
 * f* = (b*p - q)/b with b = odds - 1, q = 1 - p; the staked fraction is
 * min(fraction * f* * sizeMultiplier, maxFractionOfBankroll), floored to whole micro-USD.
 * Returns a stake of 0 when there is no edge (f* <= 0) or the quantized stake rounds to 0.
 * The sizeMultiplier (default 1) is the market-decorrelation overlay's bounded confidence
 * weight: it scales the fractional Kelly WITHIN the cap, so an independent rating can lift the
 * stake toward maxFractionOfBankroll on corroboration or cut it on contradiction, but never push
 * it above the cap. sourceRef: docs/research/quant-methods.md item 4; quant/elo.ts (overlay).
 */
export const kellyStake = (
  fairProb: Prob,
  offeredOddsMilli: DecimalOddsMilli,
  bankroll: MicroUsd,
  config: KellyConfig,
  sizeMultiplier = 1,
): Result<MicroUsd, QuantError> => {
  if (!(config.fraction > 0 && config.fraction <= 1)) {
    return err({ kind: 'invalid-config', detail: `fraction=${config.fraction} not in (0,1]` });
  }
  if (!(config.maxFractionOfBankroll > 0 && config.maxFractionOfBankroll <= 1)) {
    return err({
      kind: 'invalid-config',
      detail: `maxFractionOfBankroll=${config.maxFractionOfBankroll} not in (0,1]`,
    });
  }
  if (!(sizeMultiplier >= 0 && Number.isFinite(sizeMultiplier))) {
    return err({
      kind: 'invalid-config',
      detail: `sizeMultiplier=${sizeMultiplier} must be finite and >= 0`,
    });
  }

  // A fair probability of exactly 0 or 1 is never a real de-vig output (clampProb can emit
  // a boundary value); treat it as untrustworthy certainty and stake nothing rather than
  // letting p = 1 drive the staked fraction straight to its cap. A genuine edge has 0 < p < 1.
  if (!(fairProb > 0 && fairProb < 1)) {
    return ok(microUsdSaturating(0n));
  }

  const netOdds = offeredOddsMilli / ODDS_MILLI_SCALE - 1; // b = o - 1, positive by the odds brand
  const loseProb = 1 - fairProb;
  const fullKelly = (netOdds * fairProb - loseProb) / netOdds;
  if (!(fullKelly > 0)) {
    return ok(microUsdSaturating(0n)); // no edge, no stake
  }

  // Number(bankroll) is exact for any paper/devnet bankroll (micro-USD well under 2^53,
  // about 9e9 USD); money stays integer everywhere else. The fraction is a float in [0,1].
  const stakedFraction = Math.min(
    config.fraction * fullKelly * sizeMultiplier,
    config.maxFractionOfBankroll,
  );
  const stakeMicro = BigInt(Math.floor(stakedFraction * Number(bankroll)));
  return ok(microUsdSaturating(stakeMicro));
};
