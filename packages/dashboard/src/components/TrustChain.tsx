import { Fragment, type ReactNode } from 'react';
import { CheckIcon } from './primitives';

/**
 * A compact, static explainer of the verifiability model: why this on-chain track record
 * cannot be cherry-picked or backfilled. Three links, the last in the reserved green (the only
 * green is on-chain proof). It carries no data; it answers "how does this actually work" at a
 * glance, the question the demo has to land because matches are not live at judging time.
 */

const SealIcon = ({ size = 15 }: { readonly size?: number }): ReactNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
    <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
    <path d="M8 10.5 V7 a4 4 0 0 1 8 0 v3.5" />
  </svg>
);

const OracleIcon = ({ size = 15 }: { readonly size?: number }): ReactNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
    <ellipse cx="12" cy="6" rx="7" ry="3" />
    <path d="M5 6 v12 a7 3 0 0 0 14 0 V6" />
    <path d="M5 12 a7 3 0 0 0 14 0" />
  </svg>
);

type TrustStep = {
  readonly title: string;
  readonly body: string;
  readonly icon: ReactNode;
  readonly isProof: boolean;
};

const STEPS: readonly TrustStep[] = [
  {
    title: 'Commit before kickoff',
    body: 'keccak256 of the borsh-encoded decision is sealed on-chain. Side, price, and stake stay hidden, so a decision cannot be backfilled after the result.',
    icon: <SealIcon />,
    isProof: false,
  },
  {
    title: 'Settle by CPI',
    body: "At the final whistle the agent reveals the sealed fields and CPIs into txoracle::validate_stat against TxLINE's daily Merkle root.",
    icon: <OracleIcon />,
    isProof: false,
  },
  {
    title: 'PnL only if proven',
    body: 'The program writes PnL only when the proof passes. A wrong fixture, a missing root, or a tampered stat reverts the whole settle.',
    icon: <CheckIcon size={14} />,
    isProof: true,
  },
];

export const TrustChain = (): ReactNode => (
  <div className="ss-card trust-chain">
    {STEPS.map((step, stepIndex) => (
      <Fragment key={step.title}>
        {stepIndex > 0 && <span className="trust-link" aria-hidden="true" />}
        <div className={`trust-step${step.isProof ? ' is-proof' : ''}`}>
          <span className="trust-icon">{step.icon}</span>
          <div className="trust-text">
            <span className="trust-title">{step.title}</span>
            <span className="trust-body">{step.body}</span>
          </div>
        </div>
      </Fragment>
    ))}
  </div>
);
