/** Display formatters for the agent snapshot. Money arrives as decimal strings of micro-USD
 * (6 implied decimals); these never use floating point for the money math. */

const withThousands = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const splitMicro = (microUsd: string): { readonly negative: boolean; readonly whole: string; readonly cents: string } | null => {
  let micro: bigint;
  try {
    micro = BigInt(microUsd);
  } catch {
    return null;
  }
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const whole = withThousands((abs / 1_000_000n).toString());
  const cents = ((abs % 1_000_000n) / 10_000n).toString().padStart(2, '0');
  return { negative, whole, cents };
};

/** Micro-USD to a plain dollar string, for example "1000000000" -> "$1,000.00". */
export const formatUsd = (microUsd: string): string => {
  const parts = splitMicro(microUsd);
  if (!parts) {
    return microUsd;
  }
  return `${parts.negative ? '-' : ''}$${parts.whole}.${parts.cents}`;
};

/** Micro-USD to a signed dollar string, for example "-25000000" -> "-$25.00", "26000000" -> "+$26.00". */
export const formatPnl = (microUsd: string): string => {
  const parts = splitMicro(microUsd);
  if (!parts) {
    return microUsd;
  }
  return `${parts.negative ? '-' : '+'}$${parts.whole}.${parts.cents}`;
};

export const isNegativeMicro = (microUsd: string): boolean => {
  try {
    return BigInt(microUsd) < 0n;
  } catch {
    return false;
  }
};

export const formatProbPct = (probability: number): string => `${(probability * 100).toFixed(1)}%`;

export const formatOdds = (oddsMilli: number): string => (oddsMilli / 1000).toFixed(3);

/** Closing line value (probability space) as signed percentage points, the edge proxy. */
export const formatClv = (clvProb: number): string => {
  const points = clvProb * 100;
  return `${points >= 0 ? '+' : ''}${points.toFixed(2)}pp`;
};

export const shortenSig = (signature: string): string =>
  signature.length <= 12 ? signature : `${signature.slice(0, 6)}…${signature.slice(-6)}`;

const OUTCOME_LABELS: Readonly<Record<string, string>> = {
  home: 'Home',
  draw: 'Draw',
  away: 'Away',
  other: 'Other',
};

export const outcomeLabel = (outcome: string): string => OUTCOME_LABELS[outcome] ?? outcome;
