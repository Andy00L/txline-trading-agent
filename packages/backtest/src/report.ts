import { microUsdToFixed2 } from '@txline-agent/core';
import type { BacktestRun } from './run.js';

// Deterministic formatting: fixed decimals only, no clock-derived text, so the same run
// always renders the same bytes.
const asPercent = (value: number): string => `${(value * 100).toFixed(2)}%`;
const asFixed = (value: number, decimals = 4): string => value.toFixed(decimals);
// Exact integer-to-fixed formatting (no Number(bigint) float path). sourceRef: core units.ts.
const asUsdc = (micro: bigint): string => `${microUsdToFixed2(micro)} USDC`;

/**
 * Render the backtest metrics as a deterministic markdown report. The same BacktestRun
 * always produces byte-identical output (numbers come from the data, not the wall clock).
 */
export const renderMarkdownReport = (run: BacktestRun): string => {
  const metrics = run.metrics;
  const lines: string[] = [
    '# Backtest report',
    '',
    '## Summary',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Bets | ${metrics.bets} |`,
    `| Wins / Losses | ${metrics.wins} / ${metrics.losses} |`,
    `| Hit rate | ${asPercent(metrics.hitRate)} |`,
    `| Total staked | ${asUsdc(metrics.totalStaked)} |`,
    `| Realized PnL | ${asUsdc(metrics.totalPnl)} |`,
    `| ROI | ${asPercent(metrics.roi)} |`,
    `| Final bankroll | ${asUsdc(metrics.finalBankroll)} |`,
    `| Max drawdown | ${asUsdc(metrics.maxDrawdown)} |`,
    '',
    '## Edge (Closing Line Value)',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Mean CLV (probability) | ${asFixed(metrics.meanClvProb)} |`,
    `| CLV-positive rate | ${asPercent(metrics.clvPositiveRate)} |`,
    `| CLV samples | ${metrics.clvSamples} of ${metrics.bets} |`,
    `| Mean implied probability | ${asFixed(metrics.meanImpliedProb)} |`,
    '',
    '## Calibration',
    '',
  ];

  if (metrics.calibration) {
    lines.push(
      `Brier ${asFixed(metrics.calibration.brier)}, log loss ${asFixed(metrics.calibration.logLoss)}.`,
      '',
      '| Bin | Count | Mean predicted | Fraction positive |',
      '| --- | --- | --- | --- |',
    );
    for (const bin of metrics.calibration.curve) {
      if (bin.count > 0) {
        lines.push(
          `| ${asFixed(bin.lower, 1)}-${asFixed(bin.upper, 1)} | ${bin.count} | ${asFixed(bin.meanPredicted)} | ${asFixed(bin.fractionPositive)} |`,
        );
      }
    }
  } else {
    lines.push('No settled bets.');
  }
  lines.push('');
  return lines.join('\n');
};
