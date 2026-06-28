import { err, ok, type Result } from '@txline-agent/core';
import type { RevealArgs } from './borsh.js';
import type { ProofNodeInput } from './settle-encode.js';
import type { ProveOddsArgsInput } from './prove-odds-encode.js';
import { bytesFromByteArray, type BuildSettleArgsError, type WireProofNode } from './settle-args.js';

/**
 * The GET /api/odds/validation response, as the structural shape this package consumes.
 * onchain-client owns this contract rather than importing the txline zod type, so the dependency
 * stays core-only (the caller feeds a parsed txline OddsValidation in; it is structurally
 * assignable). The Odds snapshot uses PascalCase field names; the summary is camelCase. sourceRef:
 * packages/txline/src/schemas/proof.ts (OddsValidation, v1.5.2).
 */
export type WireOddsSnapshot = {
  readonly FixtureId: number;
  readonly MessageId: string;
  readonly Ts: number;
  readonly Bookmaker: string;
  readonly BookmakerId: number;
  readonly SuperOddsType: string;
  readonly GameState?: string | null | undefined;
  readonly InRunning: boolean;
  readonly MarketParameters?: string | null | undefined;
  readonly MarketPeriod?: string | null | undefined;
  readonly PriceNames?: readonly string[] | null | undefined;
  readonly Prices?: readonly number[] | null | undefined;
};
export type WireOddsBatchSummary = {
  readonly fixtureId: number;
  readonly updateStats: {
    readonly updateCount: number;
    readonly minTimestamp: number;
    readonly maxTimestamp: number;
  };
  readonly oddsSubTreeRoot: readonly number[];
};
export type OddsValidationInput = {
  readonly odds: WireOddsSnapshot;
  readonly summary: WireOddsBatchSummary;
  readonly subTreeProof: readonly WireProofNode[] | null;
  readonly mainTreeProof: readonly WireProofNode[] | null;
};

const convertProof = (
  nodes: readonly WireProofNode[] | null | undefined,
  label: string,
): Result<ProofNodeInput[], BuildSettleArgsError> => {
  const list = nodes ?? [];
  const out: ProofNodeInput[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const node = list[index];
    if (!node) {
      continue;
    }
    const hash = bytesFromByteArray(node.hash, `${label}[${index}].hash`);
    if (!hash.ok) {
      return hash;
    }
    out.push({ hash: hash.value, isRightSibling: node.isRightSibling });
  }
  return ok(out);
};

const checkSafeIntegers = (
  fields: readonly (readonly [number, string])[],
): BuildSettleArgsError | null => {
  for (const [value, field] of fields) {
    if (!Number.isSafeInteger(value)) {
      return { kind: 'bad-integer', field, detail: `${field} must be a safe integer, got ${value}` };
    }
  }
  return null;
};

/**
 * Assemble the prove_entry_odds ProveOddsArgs from an odds validation proof, the sealed reveal,
 * and the index of the backed 1X2 side in the snapshot's parallel PriceNames/Prices arrays. The
 * on-chain handler binds prices[sideIndex] to the sealed entry odds for the committed fixture and
 * side, then a validate_odds CPI proves the snapshot is a leaf of the published odds batch tree.
 * The caller picks sideIndex from PriceNames so it lines up with the sealed side. sourceRef:
 * programs/agent_ledger/src/lib.rs (ProveEntryOdds); packages/txline/src/schemas/proof.ts.
 */
export const buildProveOddsArgs = (input: {
  readonly validation: OddsValidationInput;
  readonly reveal: RevealArgs;
  readonly sideIndex: number;
}): Result<ProveOddsArgsInput, BuildSettleArgsError> => {
  const { odds, summary } = input.validation;
  const prices = odds.Prices ?? [];

  const badInteger = checkSafeIntegers([
    [odds.FixtureId, 'odds.FixtureId'],
    [odds.Ts, 'odds.Ts'],
    [odds.BookmakerId, 'odds.BookmakerId'],
    [summary.fixtureId, 'summary.fixtureId'],
    [summary.updateStats.updateCount, 'summary.updateStats.updateCount'],
    [summary.updateStats.minTimestamp, 'summary.updateStats.minTimestamp'],
    [summary.updateStats.maxTimestamp, 'summary.updateStats.maxTimestamp'],
    ...prices.map((price, index): readonly [number, string] => [price, `odds.Prices[${index}]`]),
  ]);
  if (badInteger) {
    return err(badInteger);
  }

  const oddsSubTreeRoot = bytesFromByteArray(summary.oddsSubTreeRoot, 'summary.oddsSubTreeRoot');
  if (!oddsSubTreeRoot.ok) {
    return oddsSubTreeRoot;
  }
  const subTreeProof = convertProof(input.validation.subTreeProof, 'subTreeProof');
  if (!subTreeProof.ok) {
    return subTreeProof;
  }
  const mainTreeProof = convertProof(input.validation.mainTreeProof, 'mainTreeProof');
  if (!mainTreeProof.ok) {
    return mainTreeProof;
  }

  return ok({
    reveal: input.reveal,
    ts: BigInt(odds.Ts),
    oddsSnapshot: {
      fixtureId: BigInt(odds.FixtureId),
      messageId: odds.MessageId,
      ts: BigInt(odds.Ts),
      bookmaker: odds.Bookmaker,
      bookmakerId: odds.BookmakerId,
      superOddsType: odds.SuperOddsType,
      gameState: odds.GameState ?? null,
      inRunning: odds.InRunning,
      marketParameters: odds.MarketParameters ?? null,
      marketPeriod: odds.MarketPeriod ?? null,
      priceNames: [...(odds.PriceNames ?? [])],
      prices: [...prices],
    },
    summary: {
      fixtureId: BigInt(summary.fixtureId),
      updateStats: {
        updateCount: summary.updateStats.updateCount,
        minTimestamp: BigInt(summary.updateStats.minTimestamp),
        maxTimestamp: BigInt(summary.updateStats.maxTimestamp),
      },
      oddsSubTreeRoot: oddsSubTreeRoot.value,
    },
    subTreeProof: subTreeProof.value,
    mainTreeProof: mainTreeProof.value,
    sideIndex: input.sideIndex,
  });
};
