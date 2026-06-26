import { ODDS_MILLI_SCALE, type DecimalOddsMilli, type Prob } from '../units.js';

/**
 * Expected value per unit staked for a bet at the offered odds, given the fair
 * probability: EV = fairProb * decimalOdds - 1. Positive when the fair probability
 * beats the offered implied probability (1/odds). Use the de-vigged fair
 * probability, not the raw implied one. sourceRef: docs/research/quant-methods.md item 3.
 */
export const expectedValue = (fairProb: Prob, offeredOddsMilli: DecimalOddsMilli): number =>
  fairProb * (offeredOddsMilli / ODDS_MILLI_SCALE) - 1;
