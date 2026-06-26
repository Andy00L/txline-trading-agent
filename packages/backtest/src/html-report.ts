import { MICRO_USD_SCALE } from '@txline-agent/core';
import type { CalibrationReport, EquityPoint } from './metrics.js';
import type { BacktestRun } from './run.js';

// One reserved blue and one reserved green, reusing the project design tokens.
const ACCENT = '#2B5FD9';
const POSITIVE = '#1F8A5B';
const INK = '#1B1F24';
const MUTED = '#6B7280';

const asPercent = (value: number): string => `${(value * 100).toFixed(2)}%`;
const asFixed = (value: number, decimals = 4): string => value.toFixed(decimals);
const asUsdc = (micro: bigint): string =>
  `${(Number(micro) / Number(MICRO_USD_SCALE)).toFixed(2)} USDC`;
const escapeText = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const EQUITY_WIDTH = 640;
const EQUITY_HEIGHT = 220;
const RELIABILITY_SIZE = 240;
const PAD = 32;

/** A deterministic inline SVG of the equity curve (bankroll over settled bets). */
const equitySvg = (points: readonly EquityPoint[], startingBankroll: number): string => {
  if (points.length === 0) {
    return '<p class="muted">No settled bets to plot.</p>';
  }
  const balances = [startingBankroll, ...points.map((point) => Number(point.bankroll))];
  const minBalance = Math.min(...balances);
  const maxBalance = Math.max(...balances);
  const rangeBalance = maxBalance - minBalance || 1;
  const maxIndex = Math.max(1, points.length);
  const scaleX = (position: number): number =>
    PAD + (position / maxIndex) * (EQUITY_WIDTH - 2 * PAD);
  const scaleY = (balance: number): number =>
    EQUITY_HEIGHT - PAD - ((balance - minBalance) / rangeBalance) * (EQUITY_HEIGHT - 2 * PAD);
  const commands = [`M ${scaleX(0).toFixed(2)} ${scaleY(startingBankroll).toFixed(2)}`];
  for (const point of points) {
    commands.push(`L ${scaleX(point.index + 1).toFixed(2)} ${scaleY(Number(point.bankroll)).toFixed(2)}`);
  }
  const baseline = scaleY(startingBankroll).toFixed(2);
  return [
    `<svg viewBox="0 0 ${EQUITY_WIDTH} ${EQUITY_HEIGHT}" role="img" aria-label="Equity curve">`,
    `<line x1="${PAD}" y1="${baseline}" x2="${EQUITY_WIDTH - PAD}" y2="${baseline}" stroke="${MUTED}" stroke-dasharray="4 4" stroke-width="1"/>`,
    `<path d="${commands.join(' ')}" fill="none" stroke="${ACCENT}" stroke-width="2"/>`,
    '</svg>',
  ].join('');
};

/** A deterministic inline SVG reliability diagram (predicted vs realized, with y=x). */
const reliabilitySvg = (calibration: CalibrationReport | null): string => {
  if (!calibration) {
    return '<p class="muted">No calibration data.</p>';
  }
  const scaleX = (value: number): number => PAD + value * (RELIABILITY_SIZE - 2 * PAD);
  const scaleY = (value: number): number =>
    RELIABILITY_SIZE - PAD - value * (RELIABILITY_SIZE - 2 * PAD);
  const dots = calibration.curve
    .filter((bin) => bin.count > 0)
    .map(
      (bin) =>
        `<circle cx="${scaleX(bin.meanPredicted).toFixed(2)}" cy="${scaleY(bin.fractionPositive).toFixed(2)}" r="4" fill="${POSITIVE}"/>`,
    )
    .join('');
  return [
    `<svg viewBox="0 0 ${RELIABILITY_SIZE} ${RELIABILITY_SIZE}" role="img" aria-label="Reliability diagram">`,
    `<path d="M ${scaleX(0).toFixed(2)} ${scaleY(0).toFixed(2)} L ${scaleX(1).toFixed(2)} ${scaleY(1).toFixed(2)}" stroke="${MUTED}" stroke-dasharray="4 4" stroke-width="1" fill="none"/>`,
    dots,
    '</svg>',
  ].join('');
};

const summaryRows = (run: BacktestRun): string => {
  const metrics = run.metrics;
  const rows: ReadonlyArray<readonly [string, string]> = [
    ['Bets', `${metrics.bets}`],
    ['Wins / Losses', `${metrics.wins} / ${metrics.losses}`],
    ['Hit rate', asPercent(metrics.hitRate)],
    ['Total staked', asUsdc(metrics.totalStaked)],
    ['Realized PnL', asUsdc(metrics.totalPnl)],
    ['ROI', asPercent(metrics.roi)],
    ['Final bankroll', asUsdc(metrics.finalBankroll)],
    ['Max drawdown', asUsdc(metrics.maxDrawdown)],
    ['Mean CLV (probability)', asFixed(metrics.meanClvProb)],
    ['CLV-positive rate', asPercent(metrics.clvPositiveRate)],
  ];
  return rows
    .map(([label, value]) => `<tr><td>${escapeText(label)}</td><td>${escapeText(value)}</td></tr>`)
    .join('');
};

/**
 * Render the backtest as a self-contained HTML page: inline CSS and inline SVG only, no
 * external fetch, so it opens anywhere and renders identically. Deterministic: the same
 * BacktestRun produces byte-identical HTML. sourceRef: docs/BUILD_PLAN.md (M5 report).
 */
export const renderHtmlReport = (run: BacktestRun): string => {
  const startingBankroll = Number(run.metrics.finalBankroll - run.metrics.totalPnl);
  const calibrationLine = run.metrics.calibration
    ? `Brier ${asFixed(run.metrics.calibration.brier)}, log loss ${asFixed(run.metrics.calibration.logLoss)}.`
    : 'No settled bets.';
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8"/>',
    '<title>Backtest report</title>',
    '<style>',
    `:root{color-scheme:light}body{margin:0;padding:24px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:${INK};background:#FBFBF9}`,
    'h1{font-size:20px;margin:0 0 16px}h2{font-size:14px;margin:24px 0 8px;text-transform:uppercase;letter-spacing:.04em}',
    'table{border-collapse:collapse;font-variant-numeric:tabular-nums}td{padding:4px 16px 4px 0}td:last-child{text-align:right}',
    `.muted{color:${MUTED}}.grid{display:flex;flex-wrap:wrap;gap:32px;align-items:flex-start}svg{background:#fff;border:1px solid #E5E7EB;border-radius:8px}`,
    '</style>',
    '</head>',
    '<body>',
    '<h1>Backtest report</h1>',
    '<h2>Summary</h2>',
    `<table><tbody>${summaryRows(run)}</tbody></table>`,
    '<div class="grid">',
    `<div><h2>Equity curve</h2>${equitySvg(run.metrics.equityCurve, startingBankroll)}</div>`,
    `<div><h2>Reliability</h2>${reliabilitySvg(run.metrics.calibration)}</div>`,
    '</div>',
    '<h2>Calibration</h2>',
    `<p class="muted">${escapeText(calibrationLine)}</p>`,
    '</body>',
    '</html>',
  ].join('\n');
};
