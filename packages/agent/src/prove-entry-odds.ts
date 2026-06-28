import { ok, type Result } from '@txline-agent/core';
import {
  buildProveOddsArgs,
  type OnChainError,
  type ProveOddsArgsInput,
  type RevealArgs,
} from '@txline-agent/onchain-client';
import type { OddsPayload, OddsValidation, TxlineError } from '@txline-agent/txline';
import { SIDE_AWAY, SIDE_DRAW, SIDE_HOME } from './reveal.js';

/**
 * The live entry-odds proof: after a decision settles, prove its sealed entry price was a real
 * published TxLINE quote by re-discovering the 1X2 odds record whose price for the backed side
 * equals the sealed entry_odds_milli, fetching that record's Merkle proof, and CPIing into
 * validate_odds. Binding to the sealed price keeps the proof sound (the program enforces
 * prices[side_index] == entry_odds_milli regardless) and lands on the exact quote the agent
 * committed against. This is the proven prove:e2e flow moved into the live loop; the e2e tool
 * remains the standalone demonstration. sourceRef: tools/devnet/src/prove-odds-e2e.ts.
 */

// The 1X2 result market in the odds feed; the entry-odds proof is only for this market.
// sourceRef: programs/agent_ledger/src/state.rs SUPER_ODDS_TYPE_1X2.
const SUPER_ODDS_TYPE_1X2 = '1X2_PARTICIPANT_RESULT';
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const INTERVALS_PER_HOUR = 12; // the /updates feed buckets each hour into 12 five-minute intervals
// How far back from the final-whistle ts to scan for the sealed entry record. Entry is committed
// 5 minutes to 6 hours before kickoff and a match runs about 2 hours, so 8 hours covers it.
// sourceRef: packages/core/src/signal/cross-market.ts (minLeadMs/maxLeadMs).
const ODDS_LOOKBACK_HOURS = 8;

/** The slice of TxlineClient the entry-odds proof needs: scan the historical odds feed and fetch
 * one odds record's validation proof. TxlineClient satisfies it. */
export interface OddsProofSource {
  getOddsUpdates(
    epochDay: number,
    hourOfDay: number,
    interval: number,
  ): Promise<Result<readonly OddsPayload[], TxlineError>>;
  getOddsValidation(params: {
    readonly messageId: string;
    readonly ts: number;
  }): Promise<Result<OddsValidation, TxlineError>>;
}

/** The slice of the on-chain port the entry-odds proof needs. SolanaOnChainPort satisfies it. */
export interface EntryOddsProvePort {
  proveEntryOdds(request: {
    readonly index: bigint;
    readonly proveOddsArgs: ProveOddsArgsInput;
  }): Promise<Result<{ readonly txSig: string; readonly proven: boolean }, OnChainError>>;
}

// The 1X2 side a price label denotes, matching the on-chain side_matches_label: home is "1"/"part1",
// draw is "X"/"draw", away is "2"/"part2" (trimmed, case-insensitive). sourceRef: logic.rs.
const sideForLabel = (label: string): number | null => {
  const lowered = label.trim().toLowerCase();
  if (lowered === '1' || lowered === 'part1') {
    return SIDE_HOME;
  }
  if (lowered === 'x' || lowered === 'draw') {
    return SIDE_DRAW;
  }
  if (lowered === '2' || lowered === 'part2') {
    return SIDE_AWAY;
  }
  return null;
};

type WindowCoord = { readonly epochDay: number; readonly hourOfDay: number };

// The (epochDay, hourOfDay) buckets covering lookbackHours up to and including anchorTs, newest
// first, to walk the /updates feed backwards from the final-whistle time.
const lookbackWindows = (anchorTs: number, lookbackHours: number): WindowCoord[] => {
  const windows: WindowCoord[] = [];
  for (let hoursBack = 0; hoursBack < lookbackHours; hoursBack += 1) {
    const bucketTs = anchorTs - hoursBack * HOUR_MS;
    windows.push({
      epochDay: Math.floor(bucketTs / DAY_MS),
      hourOfDay: Math.floor((bucketTs % DAY_MS) / HOUR_MS),
    });
  }
  return windows;
};

type EntryRecord = { readonly oddsValidation: OddsValidation; readonly sideIndex: number };

// Find the sealed entry odds record: a 1X2 odds update for the fixture whose price for the backed
// side equals the sealed entry_odds_milli, then fetch its validation proof. Returns ok(null) when
// none is in the window (the record aged out), or the TxlineError when the proof fetch itself fails.
const discoverEntryOddsRecord = async (
  oddsProofs: OddsProofSource,
  params: {
    readonly fixtureId: number;
    readonly side: number;
    readonly entryOddsMilli: number;
    readonly anchorTs: number;
  },
): Promise<Result<EntryRecord | null, TxlineError>> => {
  for (const { epochDay, hourOfDay } of lookbackWindows(params.anchorTs, ODDS_LOOKBACK_HOURS)) {
    for (let interval = INTERVALS_PER_HOUR - 1; interval >= 0; interval -= 1) {
      const updates = await oddsProofs.getOddsUpdates(epochDay, hourOfDay, interval);
      if (!updates.ok) {
        continue; // a missing interval is normal on the /updates feed; keep scanning
      }
      for (const odds of updates.value) {
        if (odds.FixtureId !== params.fixtureId || odds.SuperOddsType !== SUPER_ODDS_TYPE_1X2) {
          continue;
        }
        const priceNames = odds.PriceNames ?? [];
        const prices = odds.Prices ?? [];
        if (priceNames.length === 0 || priceNames.length !== prices.length) {
          continue;
        }
        const sideIndex = priceNames.findIndex((label) => sideForLabel(label) === params.side);
        if (sideIndex < 0 || prices[sideIndex] !== params.entryOddsMilli) {
          continue;
        }
        const validation = await oddsProofs.getOddsValidation({
          messageId: odds.MessageId,
          ts: odds.Ts,
        });
        if (!validation.ok) {
          return validation; // the record exists but its proof is unavailable; surface the error
        }
        return ok({ oddsValidation: validation.value, sideIndex });
      }
    }
  }
  return ok(null);
};

export type ProveEntryOddsOutcome =
  | { readonly kind: 'proven'; readonly txSig: string }
  | { readonly kind: 'skipped'; readonly detail: string }
  | { readonly kind: 'failed'; readonly detail: string };

/**
 * Prove a settled decision's sealed entry odds on-chain. Best-effort: a missing record or an
 * unavailable proof is 'skipped' (the settle already stands as the second trust link); only a
 * built proof that reverts or returns unproven is 'failed'. The caller logs accordingly.
 */
export const proveEntryOddsForReveal = async (
  deps: { readonly oddsProofs: OddsProofSource; readonly port: EntryOddsProvePort },
  input: { readonly reveal: RevealArgs; readonly index: bigint; readonly anchorTs: number },
): Promise<ProveEntryOddsOutcome> => {
  const record = await discoverEntryOddsRecord(deps.oddsProofs, {
    fixtureId: Number(input.reveal.fixtureId),
    side: input.reveal.side,
    entryOddsMilli: input.reveal.entryOddsMilli,
    anchorTs: input.anchorTs,
  });
  if (!record.ok) {
    return { kind: 'skipped', detail: `odds validation fetch failed: ${record.error.kind}` };
  }
  if (record.value === null) {
    return { kind: 'skipped', detail: 'no matching 1X2 odds record in the validation window' };
  }
  const proveArgs = buildProveOddsArgs({
    validation: record.value.oddsValidation,
    reveal: input.reveal,
    sideIndex: record.value.sideIndex,
  });
  if (!proveArgs.ok) {
    return { kind: 'failed', detail: `prove-args ${proveArgs.error.field}: ${proveArgs.error.detail}` };
  }
  const proven = await deps.port.proveEntryOdds({ index: input.index, proveOddsArgs: proveArgs.value });
  if (!proven.ok) {
    return { kind: 'failed', detail: `prove reverted: ${proven.error.kind} ${proven.error.detail}` };
  }
  if (!proven.value.proven) {
    return { kind: 'failed', detail: 'prove returned but decision not marked entry_odds_proven' };
  }
  return { kind: 'proven', txSig: proven.value.txSig };
};
