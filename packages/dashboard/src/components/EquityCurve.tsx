import type { ReactNode } from 'react';
import type { EquitySeries } from '../series';
import { formatUsd } from '../format';

/**
 * Paper-bankroll equity curve, reconstructed from the settled positions in the live snapshot
 * (no API change, no time-series store). The line draws on with a CSS stroke animation as the
 * data arrives, so a new settlement visibly extends the curve. Geometry converts micro-USD to
 * Number for pixel positions only; every displayed dollar figure stays exact via formatUsd.
 */

const WIDTH = 320;
const HEIGHT = 132;
const PAD = { left: 12, right: 14, top: 16, bottom: 16 } as const;

type EquityNode = {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly isStart: boolean;
  readonly won: boolean;
};

export const EquityCurve = ({ series }: { readonly series: EquitySeries }): ReactNode => {
  if (series.points.length === 0) {
    return (
      <div className="ss-card chart-card">
        <div className="chart-head">
          <span className="chart-title">Equity curve</span>
        </div>
        <p className="chart-empty">The paper-bankroll curve draws after the first settlement.</p>
      </div>
    );
  }

  const startNum = Number(series.startMicroUsd);
  const minNum = Number(series.minMicroUsd);
  const maxNum = Number(series.maxMicroUsd);
  const span = maxNum - minNum || 1; // a flat run would divide by zero
  const lo = minNum - span * 0.14;
  const hi = maxNum + span * 0.14;
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const count = series.points.length;
  const floorY = PAD.top + plotH;
  const xAt = (orderIndex: number): number => PAD.left + (orderIndex / count) * plotW;
  const yAt = (value: number): number => PAD.top + plotH - ((value - lo) / (hi - lo)) * plotH;

  const nodes: readonly EquityNode[] = [
    { key: 'start', x: xAt(0), y: yAt(startNum), isStart: true, won: true },
    ...series.points.map((point) => ({
      key: `s${point.settleIndex}`,
      x: xAt(point.settleIndex),
      y: yAt(Number(point.bankrollMicroUsd)),
      isStart: false,
      won: point.won,
    })),
  ];

  const linePath = nodes
    .map((node, nodeIndex) => `${nodeIndex === 0 ? 'M' : 'L'} ${node.x.toFixed(1)} ${node.y.toFixed(1)}`)
    .join(' ');
  const areaPath = `${linePath} L ${xAt(count).toFixed(1)} ${floorY.toFixed(1)} L ${xAt(0).toFixed(1)} ${floorY.toFixed(1)} Z`;
  const baselineY = yAt(startNum);

  const lastBankroll = series.points[count - 1]?.bankrollMicroUsd ?? series.startMicroUsd;
  const endedUp = lastBankroll >= series.startMicroUsd;
  const lastNodeIndex = nodes.length - 1;

  return (
    <div className="ss-card chart-card">
      <div className="chart-head">
        <span className="chart-title">Equity curve</span>
        <span className={`chart-figure ss-mono ${endedUp ? 'pnl-pos' : 'pnl-neg'}`}>{formatUsd(lastBankroll.toString())}</span>
      </div>
      <svg className="chart-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Paper bankroll over settlements">
        <line className="chart-baseline" x1={PAD.left} y1={baselineY} x2={WIDTH - PAD.right} y2={baselineY} />
        <path className="equity-area" d={areaPath} />
        <path className="equity-line" d={linePath} pathLength={1} />
        {nodes.map((node, nodeIndex) => (
          <circle
            key={node.key}
            className={`equity-dot${node.isStart ? ' is-start' : node.won ? ' is-win' : ' is-loss'}${nodeIndex === lastNodeIndex ? ' is-last' : ''}`}
            cx={node.x}
            cy={node.y}
            r={node.isStart ? 2.4 : 2.9}
          />
        ))}
      </svg>
      <div className="chart-foot muted">
        start {formatUsd(series.startMicroUsd.toString())} · {count} settled
      </div>
    </div>
  );
};
