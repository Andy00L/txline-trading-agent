import {
  ManualClock,
  runPipeline,
  type CommittedPosition,
  type Feed,
  type PipelineConfig,
  type PipelineResult,
  type SettledPosition,
} from '@txline-agent/core';
import { ReplayFeed, type IntervalCoord, type ReplaySource } from '@txline-agent/txline';
import { computeBacktestMetrics, type BacktestMetrics } from './metrics.js';
import { RecordingSink } from './recording-sink.js';

export type BacktestRun = {
  readonly result: PipelineResult;
  readonly commits: readonly CommittedPosition[];
  readonly settlements: readonly SettledPosition[];
  readonly metrics: BacktestMetrics;
};

/** Drive any Feed through the production decision path and compute the report metrics. */
export const runBacktest = async (feed: Feed, config: PipelineConfig): Promise<BacktestRun> => {
  const sink = new RecordingSink();
  const result = await runPipeline(feed, sink, config);
  return {
    result,
    commits: sink.commits,
    settlements: sink.settlements,
    metrics: computeBacktestMetrics(config.startingBankroll, sink.settlements),
  };
};

/**
 * The production backtest entry point: replay a recorded window over the deterministic
 * ReplayFeed (same code the live agent runs over LiveSseFeed), so a green backtest is
 * direct evidence about live behaviour. The same source and intervals always produce the
 * same run.
 */
export const replayBacktest = (deps: {
  readonly source: ReplaySource;
  readonly intervals: readonly IntervalCoord[];
  readonly startMs: number;
  readonly config: PipelineConfig;
}): Promise<BacktestRun> => {
  const clock = new ManualClock(deps.startMs);
  const feed = new ReplayFeed({ source: deps.source, clock, intervals: deps.intervals });
  return runBacktest(feed, deps.config);
};
