import type { ReactNode } from 'react';
import type { ClvPoint, ClvSummary } from '../series';
import { formatClv } from '../format';

/**
 * Closing-line value per settled bet: the edge metric a trading desk tracks. Each bar is one
 * bet (up and accent when it beat the close, down and red when it did not); the dashed line is
 * the running mean over the live settled bets. Reported as-is, including when the mean is small
 * or negative, so the chart never overstates the edge. Bars grow from the zero line on render.
 */

const WIDTH = 320;
const HEIGHT = 132;
const PAD = { left: 12, right: 14, top: 14, bottom: 16 } as const;

export const ClvChart = ({
  points,
  summary,
}: {
  readonly points: readonly ClvPoint[];
  readonly summary: ClvSummary;
}): ReactNode => {
  if (points.length === 0) {
    return (
      <div className="ss-card chart-card">
        <div className="chart-head">
          <span className="chart-title">Closing-line value</span>
        </div>
        <p className="chart-empty">Per-bet closing-line value draws after the first settlement.</p>
      </div>
    );
  }

  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const zeroY = PAD.top + plotH / 2;
  // Symmetric scale around zero; a tiny floor keeps a degenerate all-zero run from vanishing.
  const scale = summary.maxAbsClvProb > 0 ? (plotH / 2 - 4) / summary.maxAbsClvProb : 0;
  const count = points.length;
  const slot = plotW / count;
  const barW = Math.min(15, Math.max(3, slot * 0.56));
  const meanY = zeroY - summary.meanClvProb * scale;
  const meanPositive = summary.meanClvProb >= 0;

  return (
    <div className="ss-card chart-card">
      <div className="chart-head">
        <span className="chart-title">Closing-line value</span>
        <span className={`chart-figure ss-mono ${meanPositive ? 'pnl-pos' : 'pnl-neg'}`}>{formatClv(summary.meanClvProb)} mean</span>
      </div>
      <svg className="chart-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Closing-line value per settled bet">
        <line className="chart-baseline" x1={PAD.left} y1={zeroY} x2={WIDTH - PAD.right} y2={zeroY} />
        {points.map((point, pointIndex) => {
          const height = Math.max(0.8, Math.abs(point.clvProb) * scale);
          const positive = point.clvProb >= 0;
          const barX = PAD.left + slot * pointIndex + (slot - barW) / 2;
          const barY = positive ? zeroY - height : zeroY;
          return (
            <rect
              key={point.settleIndex}
              className={`clv-bar ${positive ? 'is-pos' : 'is-neg'}`}
              x={barX}
              y={barY}
              width={barW}
              height={height}
              rx={1.5}
              style={{ animationDelay: `${pointIndex * 45}ms` }}
            >
              <title>{`bet ${point.settleIndex} · fixture ${point.fixtureId} · ${formatClv(point.clvProb)}${point.won ? ' · won' : ''}`}</title>
            </rect>
          );
        })}
        <line className="clv-mean" x1={PAD.left} y1={meanY} x2={WIDTH - PAD.right} y2={meanY} />
      </svg>
      <div className="chart-foot muted">
        {summary.positiveCount}/{summary.count} beat the close · mean {formatClv(summary.meanClvProb)}
      </div>
    </div>
  );
};
