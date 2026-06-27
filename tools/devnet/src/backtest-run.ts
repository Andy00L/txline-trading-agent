import { replayBacktest, writeReportFiles } from '@txline-agent/backtest';
import { ClientReplaySource } from '@txline-agent/txline';
import {
  buildClient,
  buildCrossMarketConfig,
  intEnv,
  REPORT_OUT_DIR,
  windowIntervals,
} from './backtest-config.js';

// Replay the cross-market strategy over one real captured World Cup window (from BACKTEST_EPOCH_DAY
// hour BACKTEST_HOUR_START for BACKTEST_SPAN_HOURS hours, rolling across days). Needs TXLINE_* in
// .env. For the multi-window group-stage report use backtest-sweep. sourceRef: docs/BUILD_PLAN.md (M5).

const main = async (): Promise<void> => {
  const startEpochDay = intEnv('BACKTEST_EPOCH_DAY', 20629);
  const hourStart = intEnv('BACKTEST_HOUR_START', 18);
  const spanHours = intEnv('BACKTEST_SPAN_HOURS', 9);
  const intervals = windowIntervals(startEpochDay, hourStart, spanHours);
  const client = buildClient();
  const config = buildCrossMarketConfig();
  const startMs = startEpochDay * 86_400_000 + hourStart * 3_600_000;

  console.log(
    `[backtest-run] replaying from epochDay ${startEpochDay} hour ${hourStart} for ${spanHours} hours (${intervals.length} intervals)`,
  );
  const run = await replayBacktest({ source: new ClientReplaySource(client), intervals, startMs, config });
  const written = await writeReportFiles(REPORT_OUT_DIR, run);
  const metrics = run.metrics;
  const clvCi = metrics.clvCi;
  console.log(
    `[backtest-run] events ${run.result.eventsProcessed}, committed ${run.result.committed}, settled ${run.result.settled}, bets ${metrics.bets}, wins ${metrics.wins}/${metrics.losses}, hitRate ${(metrics.hitRate * 100).toFixed(1)}%, meanCLV ${metrics.meanClvProb.toFixed(4)} (n=${metrics.clvSamples}${clvCi === null ? '' : `, 95% CI [${clvCi.lower.toFixed(4)}, ${clvCi.upper.toFixed(4)}]`}), ROI ${(metrics.roi * 100).toFixed(2)}%`,
  );
  console.log(`[backtest-run] wrote ${written.markdownPath} and ${written.htmlPath}`);

  // Diagnostics: which fixtures were committed (with entry lead to kickoff) and which settled.
  console.log(
    `[backtest-run] committed fixtures: ${JSON.stringify(run.commits.map((commit) => commit.decision.fixtureId))}`,
  );
  console.log(
    `[backtest-run] settled fixtures: ${JSON.stringify(run.settlements.map((settlement) => settlement.decision.fixtureId))}`,
  );
  for (const commit of run.commits) {
    console.log(
      `[backtest-run]   commit fixture ${commit.decision.fixtureId} outcome ${commit.decision.outcome} entryTs ${commit.decision.tsMs} edge ${commit.decision.edge.toFixed(4)}`,
    );
  }
};

main().catch((error: unknown) => {
  console.error(`[backtest-run] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
