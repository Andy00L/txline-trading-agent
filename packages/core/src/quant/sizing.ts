import { err, ok, type Result } from '../result.js';
import { microUsdSaturating, type MicroUsd } from '../units.js';
import type { QuantError } from './error.js';

export type SteamSizingConfig = {
  /** Base staked fraction of bankroll when steam fires, independent of entry EV. */
  readonly baseFraction: number;
  /** Additional staked fraction per unit of steam strength (the size of the fair-prob move). */
  readonly strengthScale: number;
  /** Hard cap on the staked fraction of bankroll, in (0, 1]. */
  readonly maxFraction: number;
};

/**
 * CLV-first steam sizing: stake a fraction of bankroll scaled by the steam strength,
 * independent of entry EV. The edge from steam is Closing Line Value (getting in before
 * the line moves further), not a positive entry EV, so this does not require a positive
 * Kelly fraction. On the de-margined TxLINE StablePrice the consensus line is fair
 * (booksum ~ 1), so Kelly would stake zero and never act on a move. sourceRef:
 * docs/DECISIONS.md (steam plus Closing Line Value is the primary signal).
 */
export const steamStake = (
  strength: number,
  bankroll: MicroUsd,
  config: SteamSizingConfig,
): Result<MicroUsd, QuantError> => {
  if (!(config.baseFraction >= 0)) {
    return err({ kind: 'invalid-config', detail: `baseFraction=${config.baseFraction} must be >= 0` });
  }
  if (!(config.maxFraction > 0 && config.maxFraction <= 1)) {
    return err({ kind: 'invalid-config', detail: `maxFraction=${config.maxFraction} not in (0,1]` });
  }
  const scaled = config.baseFraction + config.strengthScale * Math.max(0, strength);
  const fraction = Math.min(config.maxFraction, Math.max(0, scaled));
  const stake = BigInt(Math.floor(fraction * Number(bankroll)));
  return ok(microUsdSaturating(stake));
};
