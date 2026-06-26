import type { ReactNode } from 'react';
import type { PositionView } from '../api';
import {
  formatClv,
  formatOdds,
  formatPnl,
  formatProbPct,
  formatUsd,
  isNegativeMicro,
  outcomeLabel,
  shortenSig,
} from '../format';
import { ExplorerLink, StatusPill, VerifiedStamp } from './primitives';

const Row = ({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactNode => (
  <div className="pos-row">
    <span className="label">{label}</span>
    <span className="ss-tab">{children}</span>
  </div>
);

/**
 * One decision in the trust chain. Before the outcome it shows the sealed commit (fixture,
 * side, stake, entry odds, fair probability, the on-chain index, the commit transaction).
 * After the final whistle it adds the proven result, PnL, closing-line value, and the
 * "Verified on Solana" stamp with the settle transaction. The reserved green appears only on
 * the stamp; profit uses the accent and loss uses red, so green always means on-chain proof.
 */
export const PositionCard = ({ position }: { readonly position: PositionView }): ReactNode => {
  const settlement = position.settlement;
  return (
    <div className="ss-card pos-card">
      <div className="pos-head">
        <span className="pos-outcome">{outcomeLabel(position.outcome)}</span>
        {settlement ? <StatusPill tone="settled" label="Settled" /> : <StatusPill tone="committed" label="Committed" />}
      </div>
      <div className="pos-rows">
        <Row label="Fixture">{position.fixtureId}</Row>
        <Row label="Signal">{position.signalKind}</Row>
        <Row label="Stake">{formatUsd(position.stakeMicroUsd)}</Row>
        <Row label="Entry odds">{formatOdds(position.entryOddsMilli)}</Row>
        <Row label="Fair prob">{formatProbPct(position.fairProb)}</Row>
        <Row label="On-chain #">{position.onChainIndex}</Row>
      </div>
      <div className="pos-row">
        <span className="label">Commit</span>
        <ExplorerLink url={position.explorerUrl} label={shortenSig(position.txSig)} />
      </div>
      {settlement && (
        <>
          <div className="pos-divider" />
          <div className="pos-rows">
            <Row label="Result">{outcomeLabel(settlement.result)}</Row>
            <Row label="PnL">
              <span className={isNegativeMicro(settlement.pnlMicroUsd) ? 'pnl-neg' : 'pnl-pos'}>
                {formatPnl(settlement.pnlMicroUsd)}
              </span>
            </Row>
            <Row label="CLV">{formatClv(settlement.clvProb)}</Row>
          </div>
          <div className="pos-settle">
            <VerifiedStamp />
            <ExplorerLink url={settlement.explorerUrl} label={shortenSig(settlement.txSig)} />
          </div>
        </>
      )}
    </div>
  );
};
