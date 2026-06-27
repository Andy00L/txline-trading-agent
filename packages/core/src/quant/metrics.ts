import { err, ok, type Result } from '../result.js';
import type { Prng } from '../prng.js';
import type { DecimalOddsMilli, Prob } from '../units.js';
import type { QuantError } from './error.js';

/** A predicted probability paired with the realized binary outcome (1 if the
 * predicted event occurred). */
export type CalibrationSample = {
  readonly predicted: Prob;
  readonly outcome: 0 | 1;
};

// Clip probabilities away from 0 and 1 so the logarithm stays finite.
const LOG_LOSS_EPS = 1e-15;

/** Brier score: mean squared error between predicted probability and outcome.
 * Lower is better, range [0,1]. sourceRef: docs/research/quant-methods.md item 5. */
export const brierScore = (samples: readonly CalibrationSample[]): Result<number, QuantError> => {
  if (samples.length === 0) {
    return err({ kind: 'empty-sample' });
  }
  const total = samples.reduce(
    (sum, sample) => sum + (sample.predicted - sample.outcome) ** 2,
    0,
  );
  return ok(total / samples.length);
};

/** Log loss (cross-entropy) with natural log and clipping. Lower is better.
 * sourceRef: docs/research/quant-methods.md item 5 (scikit-learn log_loss). */
export const logLoss = (samples: readonly CalibrationSample[]): Result<number, QuantError> => {
  if (samples.length === 0) {
    return err({ kind: 'empty-sample' });
  }
  const total = samples.reduce((sum, sample) => {
    const clipped = Math.min(1 - LOG_LOSS_EPS, Math.max(LOG_LOSS_EPS, sample.predicted));
    return sum + (sample.outcome * Math.log(clipped) + (1 - sample.outcome) * Math.log(1 - clipped));
  }, 0);
  return ok(-total / samples.length);
};

export type CalibrationBin = {
  readonly lower: number;
  readonly upper: number;
  readonly count: number;
  readonly meanPredicted: number;
  readonly fractionPositive: number;
};

/**
 * Reliability curve: bin predictions into binCount equal-width bins over [0,1] and
 * report, per bin, the mean predicted probability and the realized fraction of
 * positives. A perfectly calibrated forecaster has meanPredicted == fractionPositive
 * in every populated bin. sourceRef: docs/research/quant-methods.md item 5.
 */
export const buildCalibrationCurve = (
  samples: readonly CalibrationSample[],
  binCount = 10,
): Result<readonly CalibrationBin[], QuantError> => {
  if (samples.length === 0) {
    return err({ kind: 'empty-sample' });
  }
  if (!(Number.isInteger(binCount) && binCount > 0)) {
    return err({ kind: 'invalid-config', detail: `binCount=${binCount}` });
  }

  const accumulators = Array.from({ length: binCount }, (_unused, index) => ({
    lower: index / binCount,
    upper: (index + 1) / binCount,
    predictedSum: 0,
    positiveCount: 0,
    count: 0,
  }));

  for (const sample of samples) {
    // Place in [lower, upper); the top bin includes a prediction of exactly 1.0.
    const rawIndex = Math.floor(sample.predicted * binCount);
    const index = Math.min(binCount - 1, Math.max(0, rawIndex));
    const accumulator = accumulators[index];
    if (accumulator) {
      accumulator.predictedSum += sample.predicted;
      accumulator.positiveCount += sample.outcome;
      accumulator.count += 1;
    }
  }

  const curve = accumulators.map((accumulator) => ({
    lower: accumulator.lower,
    upper: accumulator.upper,
    count: accumulator.count,
    meanPredicted: accumulator.count > 0 ? accumulator.predictedSum / accumulator.count : 0,
    fractionPositive: accumulator.count > 0 ? accumulator.positiveCount / accumulator.count : 0,
  }));
  return ok(curve);
};

/** Odds-based Closing Line Value: entry_odds / closing_odds - 1. Positive means the
 * entry secured higher decimal odds than the close. The 1000 scaling cancels in the
 * ratio. sourceRef: docs/research/quant-methods.md item 6. */
export const closingLineValueOdds = (
  entryOddsMilli: DecimalOddsMilli,
  closingOddsMilli: DecimalOddsMilli,
): number => entryOddsMilli / closingOddsMilli - 1;

/** Probability-based Closing Line Value: closing_fair_prob - entry_fair_prob.
 * Positive means the entry implied a lower probability than the sharper close.
 * De-vig both sides identically before calling. */
export const closingLineValueProb = (entryFairProb: Prob, closingFairProb: Prob): number =>
  closingFairProb - entryFairProb;

export type ConfidenceInterval = {
  readonly mean: number;
  readonly lower: number;
  readonly upper: number;
  /** The number of bootstrap resamples used (for reporting the method). */
  readonly resamples: number;
};

/**
 * Two-sided 95% percentile-bootstrap confidence interval for the mean of a sample, by
 * resampling with replacement. Deterministic given the prng, so the report stays
 * byte-identical. Returns null for an empty sample. This is what turns a point estimate of
 * mean Closing Line Value into an interval a quant can judge: whether it excludes zero.
 * sourceRef: Efron (1979) bootstrap, the percentile method.
 */
export const bootstrapMeanCi = (
  values: readonly number[],
  prng: Prng,
  resamples = 2000,
): ConfidenceInterval | null => {
  if (values.length === 0 || resamples < 1) {
    return null;
  }
  const observedMean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const resampledMeans: number[] = [];
  for (let resample = 0; resample < resamples; resample += 1) {
    let total = 0;
    for (let draw = 0; draw < values.length; draw += 1) {
      const index = Math.min(values.length - 1, Math.floor(prng.next() * values.length));
      total += values[index] ?? 0;
    }
    resampledMeans.push(total / values.length);
  }
  resampledMeans.sort((left, right) => left - right);
  const lowerIndex = Math.floor(0.025 * (resamples - 1));
  const upperIndex = Math.ceil(0.975 * (resamples - 1));
  return {
    mean: observedMean,
    lower: resampledMeans[lowerIndex] ?? observedMean,
    upper: resampledMeans[upperIndex] ?? observedMean,
    resamples,
  };
};
