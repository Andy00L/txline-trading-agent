import type { ReactNode } from 'react';

/** Checkmark glyph, reused by the verified stamp and the done phase dot. */
export const CheckIcon = ({ size = 14 }: { readonly size?: number }): ReactNode => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.6}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4.5 12.5 L9.8 17.8 L19.5 6.8" />
  </svg>
);

export type PillTone = 'live' | 'committed' | 'settled' | 'idle' | 'error';

export const StatusPill = ({ tone, label }: { readonly tone: PillTone; readonly label: string }): ReactNode => (
  <span className="ss-pill" data-tone={tone}>
    <span className="dot" />
    {label}
  </span>
);

/** The single reserved-green element: an on-chain settlement proven by the validate_stat CPI. */
export const VerifiedStamp = (): ReactNode => (
  <span className="ss-stamp">
    <CheckIcon size={14} />
    Verified on Solana
  </span>
);

export type PhaseState = 'idle' | 'active' | 'done';

export const PhaseDot = ({ state }: { readonly state: PhaseState }): ReactNode => {
  if (state === 'done') {
    return (
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: 99,
          background: 'var(--ss-accent-soft)',
          display: 'grid',
          placeItems: 'center',
          color: 'var(--ss-accent)',
        }}
      >
        <CheckIcon size={12} />
      </span>
    );
  }
  if (state === 'active') {
    return (
      <span style={{ width: 22, height: 22, display: 'grid', placeItems: 'center' }}>
        <span className="ss-spin" />
      </span>
    );
  }
  return (
    <span style={{ width: 22, height: 22, display: 'grid', placeItems: 'center' }}>
      <span style={{ width: 12, height: 12, borderRadius: 99, border: '1.5px dashed rgba(29,29,31,0.18)' }} />
    </span>
  );
};

/** External link to a Solana Explorer (devnet) transaction. */
export const ExplorerLink = ({ url, label }: { readonly url: string; readonly label: string }): ReactNode => (
  <a className="link ss-mono ss-tab" href={url} target="_blank" rel="noreferrer">
    {label} ↗
  </a>
);
