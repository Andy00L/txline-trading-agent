import { err, ok, type Result } from '../result.js';
import { decimalOddsMilliToProb, type Prob } from '../units.js';
import type { DevigMethod, FairBook, FairOutcome } from '../domain/fairbook.js';
import type { OddsLine, Outcome } from '../domain/market.js';
import type { QuantError } from './error.js';

// Bisection budget for the Shin solver. 200 halvings far exceeds machine precision
// for the [0,1) interval; the tolerance below is the real stopping condition.
const SHIN_MAX_ITERS = 200;
const SHIN_TOLERANCE = 1e-12; // |sum p_i - 1|
const SHIN_Z_UPPER = 1 - 1e-9; // stay clear of the z = 1 singularity

const clampProb = (value: number): Prob => Math.min(1, Math.max(0, value)) as Prob;

type Implied = { readonly outcome: Outcome; readonly r: number };

const impliedFromLines = (
  lines: readonly OddsLine[],
): { readonly implied: readonly Implied[]; readonly booksum: number } => {
  const implied = lines.map((line) => ({
    outcome: line.outcome,
    r: decimalOddsMilliToProb(line.decimalOddsMilli),
  }));
  const booksum = implied.reduce((sum, item) => sum + item.r, 0);
  return { implied, booksum };
};

/** Reject a book that cannot be de-vigged: no lines at all, or a single line (a lone
 * outcome normalizes to probability 1.0, which is meaningless and would size a full stake). */
const validateBookShape = (lines: readonly OddsLine[]): QuantError | null => {
  if (lines.length === 0) {
    return { kind: 'empty-market' };
  }
  if (lines.length < 2) {
    return { kind: 'degenerate-book', detail: 'single-line book' };
  }
  return null;
};

/** Multiplicative (proportional normalization) de-vig: p_i = r_i / booksum. */
export const devigMultiplicative = (lines: readonly OddsLine[]): Result<FairBook, QuantError> => {
  const shapeError = validateBookShape(lines);
  if (shapeError !== null) {
    return err(shapeError);
  }
  const { implied, booksum } = impliedFromLines(lines);
  if (!(booksum > 0)) {
    return err({ kind: 'degenerate-book', detail: `booksum=${booksum}` });
  }
  const outcomes: FairOutcome[] = implied.map((item) => ({
    outcome: item.outcome,
    fairProb: clampProb(item.r / booksum),
  }));
  return ok({ method: 'multiplicative', outcomes, booksum, overround: booksum - 1, shinZ: null });
};

// Shin positive root for one outcome at a given z (booksum normalization included).
const shinProb = (impliedProb: number, booksum: number, insiderFraction: number): number =>
  (Math.sqrt(
    insiderFraction * insiderFraction +
      (4 * (1 - insiderFraction) * impliedProb * impliedProb) / booksum,
  ) -
    insiderFraction) /
  (2 * (1 - insiderFraction));

const shinSum = (
  implied: readonly Implied[],
  booksum: number,
  insiderFraction: number,
): number => implied.reduce((sum, item) => sum + shinProb(item.r, booksum, insiderFraction), 0);

/**
 * Shin (1992/1993) de-vig: each p_i is the positive root of
 * (1 - z) p_i^2 + z p_i - r_i^2 / booksum = 0, with z solved by bisection so the
 * fair probabilities sum to 1. sourceRef: docs/research/quant-methods.md item 2.
 */
export const devigShin = (lines: readonly OddsLine[]): Result<FairBook, QuantError> => {
  const shapeError = validateBookShape(lines);
  if (shapeError !== null) {
    return err(shapeError);
  }
  const { implied, booksum } = impliedFromLines(lines);
  if (!(booksum > 0)) {
    return err({ kind: 'degenerate-book', detail: `booksum=${booksum}` });
  }

  // No margin (or an underround): there is no insider component to recover, so
  // Shin coincides with multiplicative normalization at z = 0.
  if (booksum <= 1) {
    const baseline: FairOutcome[] = implied.map((item) => ({
      outcome: item.outcome,
      fairProb: clampProb(item.r / booksum),
    }));
    return ok({ method: 'shin', outcomes: baseline, booksum, overround: booksum - 1, shinZ: 0 });
  }

  // g(z) = sum_i p_i(z) - 1 is monotone decreasing; g(0) > 0 and g(1) < 0, so a
  // unique root exists in (0, 1). Bisect for it.
  let low = 0;
  let high = SHIN_Z_UPPER;
  let insiderFraction = 0;
  let converged = false;
  for (let iteration = 0; iteration < SHIN_MAX_ITERS; iteration += 1) {
    insiderFraction = (low + high) / 2;
    const difference = shinSum(implied, booksum, insiderFraction) - 1;
    if (Math.abs(difference) <= SHIN_TOLERANCE) {
      converged = true;
      break;
    }
    if (difference > 0) {
      low = insiderFraction; // sum too high: need a larger z
    } else {
      high = insiderFraction;
    }
  }
  if (!converged) {
    return err({ kind: 'no-convergence', detail: `shin bisection, booksum=${booksum}` });
  }

  // Divide out any residual drift so the fair probabilities sum to exactly 1.
  const rawSum = shinSum(implied, booksum, insiderFraction);
  const outcomes: FairOutcome[] = implied.map((item) => ({
    outcome: item.outcome,
    fairProb: clampProb(shinProb(item.r, booksum, insiderFraction) / rawSum),
  }));
  return ok({
    method: 'shin',
    outcomes,
    booksum,
    overround: booksum - 1,
    shinZ: insiderFraction,
  });
};

export const computeFairBook = (
  lines: readonly OddsLine[],
  method: DevigMethod,
): Result<FairBook, QuantError> =>
  method === 'shin' ? devigShin(lines) : devigMultiplicative(lines);
