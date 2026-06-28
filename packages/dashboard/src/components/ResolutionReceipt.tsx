import type { ReactNode } from 'react';
import type { PositionView } from '../api';
import {
  formatOdds,
  formatPnl,
  formatUsd,
  isNegativeMicro,
  outcomeLabel,
  predicateForOutcome,
  shortenHash,
} from '../format';
import { ExplorerLink } from './primitives';

/**
 * The verifiable resolution receipt for one decision: the proof chain a viewer can follow from
 * the sealed commit to the oracle-checked settlement, the "data receipt" the track asks for.
 * Native <details> so it expands with no client state and stays keyboard-accessible. It shows
 * only what is genuinely on-chain for this position (the commit hash and the validate_stat
 * settle); it never claims more than the program proved.
 */
export const ResolutionReceipt = ({ position }: { readonly position: PositionView }): ReactNode => {
  const settlement = position.settlement;
  return (
    <details className="receipt">
      <summary className="receipt-summary">Proof receipt</summary>
      <ol className="receipt-steps">
        <li>
          <span className="receipt-step-title">Sealed before kickoff</span>
          <span className="receipt-step-body">
            commit{' '}
            <span className="ss-mono receipt-hash" title={position.commitHash}>
              {shortenHash(position.commitHash)}
            </span>{' '}
            = keccak256 of the borsh-encoded decision (side, entry odds, stake, nonce). Side and
            price stay hidden.
          </span>
          <ExplorerLink url={position.explorerUrl} label="commit tx" />
        </li>
        {settlement ? (
          <>
            <li>
              <span className="receipt-step-title">Revealed at settle</span>
              <span className="receipt-step-body">
                side {outcomeLabel(position.outcome)}, entry {formatOdds(position.entryOddsMilli)}, stake{' '}
                {formatUsd(position.stakeMicroUsd)}. The reveal must hash back to the sealed commit.
              </span>
            </li>
            <li>
              <span className="receipt-step-title">Proven on-chain</span>
              <span className="receipt-step-body">
                predicate <span className="ss-mono">{predicateForOutcome(position.outcome)}</span> checked
                by CPI into <span className="ss-mono">txoracle::validate_stat</span> against the daily
                scores Merkle root.
              </span>
              <ExplorerLink url={settlement.explorerUrl} label="settle tx" />
            </li>
            <li className="receipt-step-proof">
              <span className="receipt-step-title">PnL written only because the proof passed</span>
              <span
                className={`receipt-step-body ss-mono ${isNegativeMicro(settlement.pnlMicroUsd) ? 'pnl-neg' : 'pnl-pos'}`}
              >
                {formatPnl(settlement.pnlMicroUsd)}
              </span>
            </li>
          </>
        ) : (
          <li>
            <span className="receipt-step-title">Awaiting the final whistle</span>
            <span className="receipt-step-body">
              settlement reveals the sealed fields and proves the result by CPI into{' '}
              <span className="ss-mono">txoracle::validate_stat</span>.
            </span>
          </li>
        )}
      </ol>
    </details>
  );
};
