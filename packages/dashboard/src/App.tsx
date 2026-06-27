import { Fragment, type ReactNode } from 'react';
import type { AgentSnapshot } from './api';
import { PositionCard } from './components/PositionCard';
import { PhaseDot, StatusPill, type PhaseState, type PillTone } from './components/primitives';
import { formatPnl, formatUsd, isNegativeMicro } from './format';
import { useAgentState } from './useAgentState';

type Phase = { readonly label: string; readonly state: PhaseState; readonly count?: string };

// The autonomous pipeline, derived from the snapshot: ingest -> verify -> signal -> commit -> settle.
const derivePhases = (snapshot: AgentSnapshot): readonly Phase[] => {
  const connected = snapshot.feedStatus?.kind === 'connected';
  const ingesting = snapshot.eventsProcessed > 0;
  const committed = snapshot.commitsCount > 0;
  const settled = snapshot.settlesCount > 0;
  return [
    {
      label: 'Ingest',
      state: ingesting ? 'done' : connected ? 'active' : 'idle',
      count: `${snapshot.eventsProcessed} events`,
    },
    { label: 'Verify', state: ingesting ? 'done' : 'idle' },
    { label: 'Signal', state: committed ? 'done' : ingesting ? 'active' : 'idle' },
    { label: 'Commit', state: committed ? 'done' : 'idle', count: `${snapshot.commitsCount} sealed` },
    { label: 'Settle', state: settled ? 'done' : 'idle', count: `${snapshot.settlesCount} proven` },
  ];
};

const feedTone = (kind: string): PillTone =>
  kind === 'connected' ? 'live' : kind === 'reconnecting' ? 'error' : 'idle';

const Stat = ({ value, label }: { readonly value: string; readonly label: string }): ReactNode => (
  <div className="ss-card stat">
    <div className="stat-value ss-tab">{value}</div>
    <div className="stat-label">{label}</div>
  </div>
);

const Header = ({
  snapshot,
  connected,
}: {
  readonly snapshot: AgentSnapshot | null;
  readonly connected: boolean;
}): ReactNode => {
  // Drive the pill from the dashboard's own transport first: a dropped SSE connection shows
  // "reconnecting" rather than freezing on the last server-reported feed status (stale as live).
  const kind = !connected
    ? snapshot
      ? 'reconnecting'
      : 'connecting'
    : (snapshot?.feedStatus?.kind ?? 'connected');
  return (
    <>
      <div className="app-header">
        <span className="ss-wax" style={{ width: 22, height: 22 }} />
        <span className="app-title">TxLINE Agent</span>
        <span className="app-badge">devnet</span>
        <StatusPill tone={feedTone(kind)} label={`feed: ${kind}`} />
        <span className="app-spacer" />
        {snapshot && (
          <span className="ss-tab" style={{ fontSize: 14 }}>
            <span className="muted">realized </span>
            <span className={isNegativeMicro(snapshot.realizedPnlMicroUsd) ? 'pnl-neg' : 'pnl-pos'}>
              {formatPnl(snapshot.realizedPnlMicroUsd)}
            </span>
          </span>
        )}
      </div>
      <p className="app-sub">
        Autonomous odds agent with a trustless on-chain track record: commit each decision before
        kickoff, settle by CPI into the TxLINE oracle after the final whistle.
      </p>
      {snapshot && (
        <div className="stat-grid">
          <Stat value={`${snapshot.eventsProcessed}`} label="Events ingested" />
          <Stat value={`${snapshot.commitsCount}`} label="Decisions committed" />
          <Stat value={`${snapshot.settlesCount}`} label="Settled on-chain" />
          <Stat value={formatUsd(snapshot.bankrollMicroUsd)} label="Bankroll (paper)" />
        </div>
      )}
    </>
  );
};

export const App = (): ReactNode => {
  const { snapshot, connected } = useAgentState();
  if (!snapshot) {
    return (
      <div className="app">
        <Header snapshot={null} connected={connected} />
        <p className="empty">Connecting to the agent API…</p>
      </div>
    );
  }
  const phases = derivePhases(snapshot);
  return (
    <div className="app">
      <Header snapshot={snapshot} connected={connected} />

      <div className="section-title">Pipeline</div>
      <div className="ss-card pipeline" style={{ padding: '18px 20px' }}>
        {phases.map((phase, phaseIndex) => (
          <Fragment key={phase.label}>
            {phaseIndex > 0 && <span className="phase-link" />}
            <div className="phase">
              <PhaseDot state={phase.state} />
              <span className="phase-label">{phase.label}</span>
              {phase.count !== undefined && <span className="phase-count">{phase.count}</span>}
            </div>
          </Fragment>
        ))}
      </div>

      <div className="section-title">Position ledger</div>
      {snapshot.positions.length === 0 ? (
        <p className="empty">
          No decisions committed yet. The agent commits when a cross-market relative-value signal
          clears risk; settlements appear after the final whistle.
        </p>
      ) : (
        <div className="pos-grid">
          {snapshot.positions.map((position) => (
            <PositionCard key={position.index} position={position} />
          ))}
        </div>
      )}

      {snapshot.recentErrors.length > 0 && (
        <>
          <div className="section-title">Recent issues</div>
          <div className="ss-card log" style={{ padding: '14px 18px' }}>
            {snapshot.recentErrors.map((issue) => (
              <div className="log-row" key={`${issue.atMs}:${issue.stage}:${issue.detail}`}>
                <span className="log-stage">{issue.stage}</span>
                <span className="muted">{issue.detail}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="footer">
        Each decision is hashed on-chain before kickoff and settled by CPI into TxLINE
        validate_stat after the final whistle (the verified stamp). The walk-forward backtest
        report is generated separately by <span className="ss-mono">tools/devnet backtest:run</span>{' '}
        into backtest/out/.
      </div>
    </div>
  );
};
