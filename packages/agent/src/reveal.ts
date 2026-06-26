import { createHash } from 'node:crypto';
import { err, ok, probToBps, type Decision, type Outcome, type Result } from '@txline-agent/core';
import type { RevealArgs } from '@txline-agent/onchain-client';

/**
 * Map a sized, risk-approved Decision into the on-chain RevealArgs the commit hash seals.
 * This is glue between the core decision and the onchain-client encoding, so it lives in the
 * agent (the consumer) rather than either library.
 *
 * Side is in participant space: 0 = participant 1 wins, 1 = draw, 2 = participant 2 wins,
 * mirroring programs/agent_ledger/src/state.rs SIDE_* and the on-chain predicate, which is
 * derived over (participant1_goals - participant2_goals). The captured World Cup fixtures
 * all have participant1IsHome = true (the odds payload carries no flag), so the pipeline's
 * home/away maps straight onto participant 1 / participant 2. sourceRef:
 * docs/research/M0-recon-findings.md (A-3, A-4), packages/onchain-client/src/settle-args.ts.
 */

// 1X2 sides, mirroring programs/agent_ledger/src/state.rs SIDE_* (participant space).
export const SIDE_HOME = 0;
export const SIDE_DRAW = 1;
export const SIDE_AWAY = 2;

// The 1X2 full-time market index. sourceRef: docs/BUILD_PLAN.md (primary market = 0).
export const MARKET_1X2 = 0;

export type RevealError = { readonly kind: 'unsupported-outcome'; readonly detail: string };

const sideOfOutcome = (outcome: Outcome): number | null => {
  if (outcome === 'home') {
    return SIDE_HOME;
  }
  if (outcome === 'draw') {
    return SIDE_DRAW;
  }
  if (outcome === 'away') {
    return SIDE_AWAY;
  }
  return null; // 'other' is never committed (the pipeline only acts on 1X2 outcomes).
};

/**
 * A deterministic, non-secret hash binding the decision's signal to the commit. It is sealed
 * inside commit_hash and revealed verbatim at settle, so it must be reproducible from the
 * decision alone (no clock, no randomness).
 */
const signalHashOf = (decision: Decision): Uint8Array =>
  new Uint8Array(
    createHash('sha256')
      .update(`${decision.signalKind}:${decision.marketKey}:${decision.outcome}`)
      .digest(),
  );

export type BuildRevealInput = {
  readonly decision: Decision;
  readonly strategyBytes: Uint8Array; // 32-byte strategy PDA
  readonly index: bigint; // the on-chain decisions_count at commit time
  readonly nonce: Uint8Array; // 32-byte sealing nonce
};

/** Build the RevealArgs for a decision at a given on-chain index. Errors as a value if the
 * outcome is not a 1X2 side (which the pipeline never commits, but is checked here so a bad
 * caller fails loudly rather than sealing a wrong side). */
export const buildRevealFromDecision = (
  input: BuildRevealInput,
): Result<RevealArgs, RevealError> => {
  const side = sideOfOutcome(input.decision.outcome);
  if (side === null) {
    return err({
      kind: 'unsupported-outcome',
      detail: `cannot commit non-1X2 outcome ${input.decision.outcome}`,
    });
  }
  return ok({
    strategy: input.strategyBytes,
    index: input.index,
    fixtureId: BigInt(input.decision.fixtureId),
    market: MARKET_1X2,
    side,
    fairProbBps: probToBps(input.decision.fairProb),
    entryOddsMilli: input.decision.entryOddsMilli,
    stake: input.decision.stake,
    signalHash: signalHashOf(input.decision),
    nonce: input.nonce,
  });
};
