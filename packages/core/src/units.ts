/**
 * Branded integer and probability units. Money and odds never use floating point
 * for storage or accounting; floats are a bug class at the chain boundary.
 * Constructors validate and return a Result; the brand is applied only after the
 * runtime check passes, so a value of a branded type is always in range.
 *
 * sourceRef: docs/BUILD_PLAN.md ("money as integers, odds x1000") and
 * docs/research/M0-recon-findings.md O1 (Prices = decimal odds x1000) and the
 * IDL constant TOKEN_DECIMALS = 6.
 */
import { err, ok, type Result } from './result.js';

declare const brand: unique symbol;
export type Brand<TBase, TBrand extends string> = TBase & { readonly [brand]: TBrand };

/** Decimal odds multiplied by 1000 (three-decimal precision). 2.0 odds -> 2000. */
export type DecimalOddsMilli = Brand<number, 'DecimalOddsMilli'>;
/** A probability in the closed interval [0, 1]. */
export type Prob = Brand<number, 'Prob'>;
/** Money in integer micro-USD. 1 USD = 1_000_000 micro-USD (6 implied decimals). */
export type MicroUsd = Brand<bigint, 'MicroUsd'>;
/** Basis points, 1/10000. Used for the committed fair probability (u16 on chain). */
export type Bps = Brand<number, 'Bps'>;

/** Decimal-odds scale. sourceRef: tx-on-chain README ("decimal odds, multiplied by 1000"). */
export const ODDS_MILLI_SCALE = 1000;
/** Micro-USD scale. sourceRef: IDL constant TOKEN_DECIMALS = 6. */
export const MICRO_USD_SCALE = 1_000_000n;
/** Basis-points scale. */
export const BPS_SCALE = 10_000;

export type UnitErrorKind = 'not-finite' | 'not-integer' | 'out-of-range' | 'malformed';
export type UnitError = { readonly kind: UnitErrorKind; readonly field: string; readonly detail: string };

const unitError = (kind: UnitErrorKind, field: string, detail: string): UnitError => ({
  kind,
  field,
  detail,
});

/**
 * Build a DecimalOddsMilli. Valid decimal odds exceed 1.0, so the milli value must
 * be a finite integer strictly greater than ODDS_MILLI_SCALE.
 */
export const decimalOddsMilli = (value: number): Result<DecimalOddsMilli, UnitError> => {
  if (!Number.isFinite(value)) {
    return err(unitError('not-finite', 'DecimalOddsMilli', String(value)));
  }
  if (!Number.isInteger(value)) {
    return err(unitError('not-integer', 'DecimalOddsMilli', String(value)));
  }
  if (value <= ODDS_MILLI_SCALE) {
    return err(unitError('out-of-range', 'DecimalOddsMilli', `must exceed ${ODDS_MILLI_SCALE} (1.000)`));
  }
  return ok(value as DecimalOddsMilli);
};

/** Build a Prob in [0, 1]. */
export const prob = (value: number): Result<Prob, UnitError> => {
  if (!Number.isFinite(value)) {
    return err(unitError('not-finite', 'Prob', String(value)));
  }
  if (value < 0 || value > 1) {
    return err(unitError('out-of-range', 'Prob', `${value} not in [0,1]`));
  }
  return ok(value as Prob);
};

/** Clamp a finite number into [0, 1] and brand it Prob. Infallible; for values already
 * known to be near-probabilities (a de-vig quotient, a summed scoreline mass) that a
 * floating-point rounding can nudge a hair outside the interval. A non-finite input
 * collapses to 0 so the brand always holds a real probability. */
export const clampProb = (value: number): Prob =>
  (!Number.isFinite(value) ? 0 : value < 0 ? 0 : value > 1 ? 1 : value) as Prob;

/** Build a non-negative MicroUsd from an integer bigint. */
export const microUsd = (value: bigint): Result<MicroUsd, UnitError> => {
  if (value < 0n) {
    return err(unitError('out-of-range', 'MicroUsd', `${value} is negative`));
  }
  return ok(value as MicroUsd);
};

/** Brand a bigint as MicroUsd, saturating any negative value to 0. Infallible; for
 * computed amounts already known to be non-negative, such as a Kelly stake. */
export const microUsdSaturating = (value: bigint): MicroUsd => (value < 0n ? 0n : value) as MicroUsd;

/** Convert whole USD (integer or up to 6 decimals) to MicroUsd, rounded to the micro. */
export const usdToMicroUsd = (wholeUsd: number): Result<MicroUsd, UnitError> => {
  if (!Number.isFinite(wholeUsd)) {
    return err(unitError('not-finite', 'MicroUsd', String(wholeUsd)));
  }
  if (wholeUsd < 0) {
    return err(unitError('out-of-range', 'MicroUsd', `${wholeUsd} is negative`));
  }
  return microUsd(BigInt(Math.round(wholeUsd * Number(MICRO_USD_SCALE))));
};

/** Implied probability of decimal odds: 1000 / oddsMilli. Pure; result is in (0, 1). */
export const decimalOddsMilliToProb = (oddsMilli: DecimalOddsMilli): Prob =>
  // oddsMilli > 1000 is guaranteed by the constructor, so the quotient is in (0, 1).
  (ODDS_MILLI_SCALE / oddsMilli) as Prob;

/** Decimal odds (milli) implied by a probability in (0, 1). Rounds to the nearest milli. */
export const probToDecimalOddsMilli = (probability: Prob): Result<DecimalOddsMilli, UnitError> => {
  if (probability <= 0) {
    return err(unitError('out-of-range', 'DecimalOddsMilli', 'probability must be greater than 0'));
  }
  return decimalOddsMilli(Math.round(ODDS_MILLI_SCALE / probability));
};

/** The TxLINE Pct numeric format: an integer part, a dot, exactly three decimals (e.g. "52.632").
 * sourceRef: OpenAPI OddsPayload.Pct pattern. Shared with the odds zod schema (schemas/odds.ts). */
export const PCT_NUMBER_PATTERN = /^\d+\.\d{3}$/;

/**
 * Parse a TxLINE Pct field to a Prob, or null for "NA". The field is a percentage
 * with exactly three decimals, for example "52.632" meaning 52.632 percent.
 * sourceRef: OpenAPI OddsPayload.Pct pattern ^(NA|\d+\.\d{3})$.
 */
export const pctStringToProb = (pct: string): Result<Prob | null, UnitError> => {
  if (pct === 'NA') {
    return ok(null);
  }
  if (!PCT_NUMBER_PATTERN.test(pct)) {
    return err(unitError('malformed', 'Pct', pct));
  }
  return prob(Number(pct) / 100);
};

/** Round a probability to basis points (0..10000), the committed fair-probability unit. */
export const probToBps = (probability: Prob): Bps => Math.round(probability * BPS_SCALE) as Bps;

/** Format decimal-odds-milli for display or logs, for example 2000 -> "2.000". */
export const decimalOddsMilliToString = (oddsMilli: DecimalOddsMilli): string =>
  (oddsMilli / ODDS_MILLI_SCALE).toFixed(3);

/** Format integer micro-USD as a fixed two-decimal string with no floating point, for example
 * 1_500_000n -> "1.50" and -25_000_000n -> "-25.00". Truncates toward zero past the cent. For
 * display and reports; the money math itself stays integer (Number(bigint) loses precision above
 * 2^53 micro-USD, about 9e9 USD, which this avoids). */
export const microUsdToFixed2 = (micro: bigint): string => {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const whole = abs / MICRO_USD_SCALE;
  const cents = (abs % MICRO_USD_SCALE) / 10_000n;
  return `${negative ? '-' : ''}${whole.toString()}.${cents.toString().padStart(2, '0')}`;
};
