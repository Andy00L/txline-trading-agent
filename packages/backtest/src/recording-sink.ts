import type { CommittedPosition, PipelineSink, SettledPosition } from '@txline-agent/core';

/**
 * A PipelineSink that records every commit and settlement in arrival order, so the
 * backtest can compute metrics over the exact decisions the production driver made.
 * The M6 live agent swaps this for an on-chain sink; the decision code is identical.
 */
export class RecordingSink implements PipelineSink {
  readonly commits: CommittedPosition[] = [];
  readonly settlements: SettledPosition[] = [];

  onCommit(position: CommittedPosition): void {
    this.commits.push(position);
  }

  onSettle(position: SettledPosition): void {
    this.settlements.push(position);
  }
}
