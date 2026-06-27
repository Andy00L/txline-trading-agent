import {
  computeBacktestMetrics,
  replayBacktest,
  writeReportFiles,
  type BacktestRun,
} from '@txline-agent/backtest';
import { ClientReplaySource } from '@txline-agent/txline';
import { microUsdSaturating, type CommittedPosition, type SettledPosition } from '@txline-agent/core';
import {
  buildClient,
  buildCrossMarketConfig,
  intEnv,
  REPORT_OUT_DIR,
  windowIntervals,
} from './backtest-config.js';

// Sweep the cross-market strategy across many World Cup match-day windows and aggregate every
// settled position into one Closing Line Value / calibration report with a bootstrap CI. Each
// day-window is replayed sequentially (memory freed between) so the whole group stage fits in
// heap. Env: SWEEP_START_DAY, SWEEP_NUM_DAYS, SWEEP_START_HOUR, SWEEP_SPAN_HOURS. Needs TXLINE_*.

const main = async (): Promise<void> => {
  const startEpochDay = intEnv('SWEEP_START_DAY', 20622);
  const numDays = intEnv('SWEEP_NUM_DAYS', 8);
  const hourStart = intEnv('SWEEP_START_HOUR', 15);
  const spanHours = intEnv('SWEEP_SPAN_HOURS', 12);

  const client = buildClient();
  const config = buildCrossMarketConfig();
  const source = new ClientReplaySource(client);

  const allCommits: CommittedPosition[] = [];
  const allSettlements: SettledPosition[] = [];
  let totalEvents = 0;

  // Write the aggregate report and log the running CLV after each day, so a run torn down
  // mid-sweep still leaves an up-to-date report and the latest figures in the log.
  const writeAggregate = async (label: string): Promise<void> => {
    const metrics = computeBacktestMetrics(config.startingBankroll, allSettlements);
    const combined: BacktestRun = {
      result: {
        committed: allCommits.length,
        settled: allSettlements.length,
        finalBankroll: microUsdSaturating(metrics.finalBankroll),
        eventsProcessed: totalEvents,
      },
      commits: allCommits,
      settlements: allSettlements,
      metrics,
    };
    await writeReportFiles(REPORT_OUT_DIR, combined);
    const clvCi = metrics.clvCi;
    console.log(
      `[backtest-sweep] ${label}: committed ${allCommits.length}, settled bets ${metrics.bets}, wins ${metrics.wins}/${metrics.losses}, mean CLV ${metrics.meanClvProb.toFixed(4)} over n=${metrics.clvSamples}${clvCi === null ? '' : `, 95% CI [${clvCi.lower.toFixed(4)}, ${clvCi.upper.toFixed(4)}]`}, CLV-positive ${(metrics.clvPositiveRate * 100).toFixed(1)}%, ROI ${(metrics.roi * 100).toFixed(2)}%`,
    );
  };

  for (let dayOffset = 0; dayOffset < numDays; dayOffset += 1) {
    const epochDay = startEpochDay + dayOffset;
    const intervals = windowIntervals(epochDay, hourStart, spanHours);
    const startMs = epochDay * 86_400_000 + hourStart * 3_600_000;
    const run = await replayBacktest({ source, intervals, startMs, config });
    allCommits.push(...run.commits);
    allSettlements.push(...run.settlements);
    totalEvents += run.result.eventsProcessed;
    console.log(
      `[backtest-sweep] day ${epochDay}: events ${run.result.eventsProcessed}, committed ${run.commits.length}, settled ${run.settlements.length}`,
    );
    await writeAggregate(`through day ${epochDay}`);
  }

  await writeAggregate(`TOTAL days ${numDays}, events ${totalEvents}`);
  console.log(`[backtest-sweep] done; report at backtest/out/report.md`);
};

main().catch((error: unknown) => {
  console.error(`[backtest-sweep] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
