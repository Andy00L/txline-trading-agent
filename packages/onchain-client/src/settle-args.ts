import { err, ok, type Result } from '@txline-agent/core';
import type { RevealArgs } from './borsh.js';
import type {
  ProofNodeInput,
  SettleArgsInput,
  StatTermInput,
} from './settle-encode.js';

/**
 * The GET /api/scores/stat-validation response, as the structural shape this package
 * consumes. onchain-client owns this contract rather than importing the txline zod type,
 * so the dependency stays core-only (the agent feeds a parsed txline ScoresStatValidation
 * in; it is structurally assignable). sourceRef: docs/research/txline-api.md and
 * packages/txline/src/schemas/proof.ts (the OpenAPI ScoresStatValidation, v1.5.2).
 *
 * hash and root fields arrive as hex strings (OpenAPI format binary; the leaf encoding
 * is pinned in proof.ts). Proof lists may be null, meaning an empty branch.
 */
export type WireProofNode = { readonly hash: string; readonly isRightSibling: boolean };
export type WireScoreStat = {
  readonly key: number;
  readonly value: number;
  readonly period: number;
};
export type WireScoresUpdateStats = {
  readonly updateCount: number;
  readonly minTimestamp: number;
  readonly maxTimestamp: number;
};
export type WireScoresBatchSummary = {
  readonly fixtureId: number;
  readonly updateStats: WireScoresUpdateStats;
  readonly eventStatsSubTreeRoot: string;
};
export type StatValidationInput = {
  readonly ts: number;
  readonly statToProve: WireScoreStat;
  readonly eventStatRoot: string;
  readonly summary: WireScoresBatchSummary;
  readonly statProof: readonly WireProofNode[] | null;
  readonly subTreeProof: readonly WireProofNode[] | null;
  readonly mainTreeProof: readonly WireProofNode[] | null;
  // Explicit | undefined so a parsed txline ScoresStatValidation (zod .optional() infers
  // T | undefined) is structurally assignable under exactOptionalPropertyTypes.
  readonly statToProve2?: WireScoreStat | undefined;
  readonly statProof2?: readonly WireProofNode[] | null | undefined;
};

export type BuildSettleArgsError =
  | { readonly kind: 'missing-second-stat'; readonly field: string; readonly detail: string }
  | { readonly kind: 'bad-hash'; readonly field: string; readonly detail: string };

// Matches a run of hexadecimal digits (no 0x prefix).
const HEX_DIGITS = /^[0-9a-fA-F]+$/;

/**
 * Decode a 32-byte Merkle hash from its hex-string wire form into the bytes the on-chain
 * SettleArgs borsh expects. A leading 0x is tolerated. This is the single place the leaf
 * encoding is interpreted: if a captured live response proves the wire form is not hex,
 * only this function changes. sourceRef: packages/txline/src/schemas/proof.ts (O4).
 */
export const decodeHash32 = (
  value: string,
  field: string,
): Result<Uint8Array, BuildSettleArgsError> => {
  const hex = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
  if (hex.length !== 64) {
    return err({
      kind: 'bad-hash',
      field,
      detail: `expected 64 hex chars (32 bytes), got ${hex.length}`,
    });
  }
  if (!HEX_DIGITS.test(hex)) {
    return err({ kind: 'bad-hash', field, detail: 'contains non-hex characters' });
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return ok(bytes);
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
    const hash = decodeHash32(node.hash, `${label}[${index}].hash`);
    if (!hash.ok) {
      return hash;
    }
    out.push({ hash: hash.value, isRightSibling: node.isRightSibling });
  }
  return ok(out);
};

const buildStatTerm = (
  stat: WireScoreStat,
  eventStatRoot: Uint8Array,
  proof: readonly WireProofNode[] | null | undefined,
  label: string,
): Result<StatTermInput, BuildSettleArgsError> => {
  const statProof = convertProof(proof, `${label}.statProof`);
  if (!statProof.ok) {
    return statProof;
  }
  return ok({
    statToProve: { key: stat.key, value: stat.value, period: stat.period },
    eventStatRoot,
    statProof: statProof.value,
  });
};

/**
 * Assemble the settle_decision SettleArgs from a two-stat scores stat-validation proof
 * plus the sealed reveal and the claimed 1X2 result. The home stat comes from statToProve
 * (statKey 1, participant 1 goals) and the away stat from statToProve2 (statKey 2); both
 * share one event stat root. The on-chain handler derives the predicate from claimedResult
 * over (home - away), so a passing validate_stat CPI proves the real result matches the
 * claim. sourceRef: ~/.txline-recon/ex-onchain-validation.md (two-stat validation),
 * programs/agent_ledger/src/state.rs (SettleArgs).
 */
export const buildSettleArgs = (input: {
  readonly validation: StatValidationInput;
  readonly reveal: RevealArgs;
  readonly claimedResult: number;
}): Result<SettleArgsInput, BuildSettleArgsError> => {
  const { validation } = input;
  if (validation.statToProve2 === undefined) {
    return err({
      kind: 'missing-second-stat',
      field: 'statToProve2',
      detail: 'two-stat (home vs away) settle needs statKey2; refetch stat-validation with statKey2=2',
    });
  }
  if (validation.statProof2 === undefined) {
    return err({
      kind: 'missing-second-stat',
      field: 'statProof2',
      detail: 'two-stat settle needs statProof2; refetch stat-validation with statKey2=2',
    });
  }

  const eventStatRoot = decodeHash32(validation.eventStatRoot, 'eventStatRoot');
  if (!eventStatRoot.ok) {
    return eventStatRoot;
  }
  const eventsSubTreeRoot = decodeHash32(
    validation.summary.eventStatsSubTreeRoot,
    'summary.eventStatsSubTreeRoot',
  );
  if (!eventsSubTreeRoot.ok) {
    return eventsSubTreeRoot;
  }

  const fixtureProof = convertProof(validation.subTreeProof, 'subTreeProof');
  if (!fixtureProof.ok) {
    return fixtureProof;
  }
  const mainTreeProof = convertProof(validation.mainTreeProof, 'mainTreeProof');
  if (!mainTreeProof.ok) {
    return mainTreeProof;
  }

  const statHome = buildStatTerm(
    validation.statToProve,
    eventStatRoot.value,
    validation.statProof,
    'statHome',
  );
  if (!statHome.ok) {
    return statHome;
  }
  const statAway = buildStatTerm(
    validation.statToProve2,
    eventStatRoot.value,
    validation.statProof2,
    'statAway',
  );
  if (!statAway.ok) {
    return statAway;
  }

  return ok({
    reveal: input.reveal,
    claimedResult: input.claimedResult,
    ts: BigInt(validation.ts),
    fixtureSummary: {
      fixtureId: BigInt(validation.summary.fixtureId),
      updateStats: {
        updateCount: validation.summary.updateStats.updateCount,
        minTimestamp: BigInt(validation.summary.updateStats.minTimestamp),
        maxTimestamp: BigInt(validation.summary.updateStats.maxTimestamp),
      },
      eventsSubTreeRoot: eventsSubTreeRoot.value,
    },
    fixtureProof: fixtureProof.value,
    mainTreeProof: mainTreeProof.value,
    statHome: statHome.value,
    statAway: statAway.value,
  });
};
