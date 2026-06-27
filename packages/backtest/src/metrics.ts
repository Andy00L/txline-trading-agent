import {
  bootstrapMeanCi,
  brierScore,
  buildCalibrationCurve,
  closingLineValueProb,
  decimalOddsMilliToProb,
  logLoss,
  SeededPrng,
  type CalibrationBin,
  type CalibrationSample,
  type ConfidenceInterval,
  type SettledPosition,
} from '@txline-agent/core';

// Fixed seed so the bootstrap confidence interval is byte-identical across runs of the same data.
const CLV_BOOTSTRAP_SEED = 1;

export type CalibrationReport = {
  readonly brier: number;
  readonly logLoss: number;
  readonly curve: readonly CalibrationBin[];
};

export type EquityPoint = { readonly index: number; readonly bankroll: bigint };

export type BacktestMetrics = {
  readonly bets: number;
  readonly wins: number;
  readonly losses: number;
  readonly totalStaked: bigint;
  readonly totalPnl: bigint;
  readonly roi: number;
  readonly hitRate: number;
  readonly meanImpliedProb: number;
  /** Mean probability-space Closing Line Value: closing fair prob minus entry fair prob.
   * Positive means the consensus moved further our way after entry (the edge proxy). */
  readonly meanClvProb: number;
  readonly clvPositiveRate: number;
  /** Number of settled bets that had a known closing line (the CLV denominator). A bet with no
   * post-entry consensus observation has no defined CLV and is excluded. */
  readonly clvSamples: number;
  /** Bootstrap 95% confidence interval for mean CLV: whether the edge interval excludes zero is
   * the load-bearing question for a quant, far more than the point estimate. Null with no CLV samples. */
  readonly clvCi: ConfidenceInterval | null;
  readonly calibration: CalibrationReport | null;
  readonly equityCurve: readonly EquityPoint[];
  readonly maxDrawdown: bigint;
  readonly finalBankroll: bigint;
};

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * Aggregate the settled positions a backtest produced into the report metrics: hit rate
 * and ROI, the equity curve and max drawdown, Closing Line Value (the edge proxy), the
 * mean implied price, and calibration (Brier, log loss, reliability curve). Pure and
 * order-deterministic; the settlements arrive in a fixed order from runPipeline.
 */
export const computeBacktestMetrics = (
  startingBankroll: bigint,
  settlements: readonly SettledPosition[],
): BacktestMetrics => {
  let wins = 0;
  let totalStaked = 0n;
  let totalPnl = 0n;
  let bankroll = startingBankroll;
  let peak = startingBankroll;
  let maxDrawdown = 0n;
  const clvValues: number[] = [];
  const impliedValues: number[] = [];
  const calibrationSamples: CalibrationSample[] = [];
  const equityCurve: EquityPoint[] = [];

  let index = 0;
  for (const settlement of settlements) {
    if (settlement.won) {
      wins += 1;
    }
    totalStaked += settlement.decision.stake;
    totalPnl += settlement.pnl;
    // Only count CLV when the closing line is known (a consensus update arrived after entry); a
    // bet with no later observation has no defined CLV and would otherwise count a false zero.
    // CLV compares the market consensus at entry against the close, so it uses entryConsensusProb
    // (the de-vigged 1X2 line at entry), not the model fair probability the decision carries.
    if (settlement.closingFairProbKnown) {
      clvValues.push(closingLineValueProb(settlement.entryConsensusProb, settlement.closingFairProb));
    }
    impliedValues.push(decimalOddsMilliToProb(settlement.decision.entryOddsMilli));
    calibrationSamples.push({
      predicted: settlement.decision.fairProb,
      outcome: settlement.won ? 1 : 0,
    });
    bankroll += settlement.pnl;
    if (bankroll > peak) {
      peak = bankroll;
    }
    const drawdown = peak - bankroll;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
    equityCurve.push({ index, bankroll });
    index += 1;
  }

  const bets = settlements.length;
  let calibration: CalibrationReport | null = null;
  if (bets > 0) {
    const brier = brierScore(calibrationSamples);
    const cross = logLoss(calibrationSamples);
    const curve = buildCalibrationCurve(calibrationSamples);
    if (brier.ok && cross.ok && curve.ok) {
      calibration = { brier: brier.value, logLoss: cross.value, curve: curve.value };
    }
  }

  return {
    bets,
    wins,
    losses: bets - wins,
    totalStaked,
    totalPnl,
    roi: totalStaked > 0n ? Number(totalPnl) / Number(totalStaked) : 0,
    hitRate: bets > 0 ? wins / bets : 0,
    meanImpliedProb: mean(impliedValues),
    meanClvProb: mean(clvValues),
    clvPositiveRate:
      clvValues.length > 0 ? clvValues.filter((value) => value > 0).length / clvValues.length : 0,
    clvSamples: clvValues.length,
    clvCi: bootstrapMeanCi(clvValues, new SeededPrng(CLV_BOOTSTRAP_SEED)),
    calibration,
    equityCurve,
    maxDrawdown,
    finalBankroll: bankroll,
  };
};
