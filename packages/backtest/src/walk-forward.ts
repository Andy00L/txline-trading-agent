import { err, ok, type Feed, type PipelineConfig, type Result } from '@txline-agent/core';
import type { BacktestMetrics } from './metrics.js';
import { runBacktest } from './run.js';

export type WalkForwardError = { readonly kind: 'empty-grid'; readonly detail: string };

export type WalkForwardResult = {
  readonly chosen: PipelineConfig;
  readonly inSample: BacktestMetrics;
  readonly outOfSample: BacktestMetrics;
};

export type WalkForwardDeps = {
  /** Re-constructable feeds: each call returns a fresh feed over the same window, so the
   * grid can be evaluated by replaying the in-sample window once per config. */
  readonly inSample: () => Feed;
  readonly outOfSample: () => Feed;
  /** The configurations to tune over (a parameter grid). */
  readonly grid: readonly PipelineConfig[];
  /** Tuning objective; the config with the highest in-sample score is chosen. */
  readonly score: (metrics: BacktestMetrics) => number;
};

/**
 * Walk-forward evaluation: tune the config on the in-sample window by picking the grid
 * point with the best in-sample score, then report that config's performance on the
 * disjoint out-of-sample window. The out-of-sample metrics are the honest estimate of
 * edge, since the config never saw that data. sourceRef: docs/BUILD_PLAN.md (walk-forward).
 */
export const walkForward = async (
  deps: WalkForwardDeps,
): Promise<Result<WalkForwardResult, WalkForwardError>> => {
  if (deps.grid.length === 0) {
    return err({ kind: 'empty-grid', detail: 'walk-forward needs at least one config' });
  }
  let best: { config: PipelineConfig; metrics: BacktestMetrics; score: number } | null = null;
  for (const config of deps.grid) {
    const run = await runBacktest(deps.inSample(), config);
    const score = deps.score(run.metrics);
    if (best === null || score > best.score) {
      best = { config, metrics: run.metrics, score };
    }
  }
  if (best === null) {
    return err({ kind: 'empty-grid', detail: 'no config evaluated' });
  }
  const outOfSampleRun = await runBacktest(deps.outOfSample(), best.config);
  return ok({ chosen: best.config, inSample: best.metrics, outOfSample: outOfSampleRun.metrics });
};
