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
 * hash and root fields arrive as 32-byte arrays (number[32]); confirmed against a live
 * devnet response 2026-06-26. Proof lists may be null or empty, meaning an empty branch.
 */
export type WireProofNode = { readonly hash: readonly number[]; readonly isRightSibling: boolean };
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
  readonly eventStatsSubTreeRoot: readonly number[];
};
export type StatValidationInput = {
  readonly ts: number;
  readonly statToProve: WireScoreStat;
  readonly eventStatRoot: readonly number[];
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
  | { readonly kind: 'bad-hash'; readonly field: string; readonly detail: string }
  | { readonly kind: 'bad-integer'; readonly field: string; readonly detail: string };

/**
 * Convert a 32-byte Merkle hash from its wire form (a number[32] byte array) into the
 * Uint8Array the on-chain SettleArgs borsh expects. This is the single place the leaf
 * encoding is interpreted. sourceRef: packages/txline/src/schemas/proof.ts (O4, confirmed
 * against a live devnet response: hashes are byte arrays, not hex strings).
 */
export const bytesFromByteArray = (
  value: readonly number[],
  field: string,
): Result<Uint8Array, BuildSettleArgsError> => {
  if (value.length !== 32) {
    return err({ kind: 'bad-hash', field, detail: `expected 32 bytes, got ${value.length}` });
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    const byte = value[index];
    if (byte === undefined || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      return err({ kind: 'bad-hash', field, detail: `byte ${index} is not a 0-255 integer` });
    }
    bytes[index] = byte;
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
    const hash = bytesFromByteArray(node.hash, `${label}[${index}].hash`);
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

// Guard the JSON-number fields that become bigints, so a malformed (non-integer or unsafe)
// wire value returns a Result error instead of throwing out of an errors-as-values function.
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

  const badInteger = checkSafeIntegers([
    [validation.ts, 'ts'],
    [validation.summary.fixtureId, 'summary.fixtureId'],
    [validation.summary.updateStats.updateCount, 'summary.updateStats.updateCount'],
    [validation.summary.updateStats.minTimestamp, 'summary.updateStats.minTimestamp'],
    [validation.summary.updateStats.maxTimestamp, 'summary.updateStats.maxTimestamp'],
    [validation.statToProve.key, 'statToProve.key'],
    [validation.statToProve.value, 'statToProve.value'],
    [validation.statToProve.period, 'statToProve.period'],
    [validation.statToProve2.key, 'statToProve2.key'],
    [validation.statToProve2.value, 'statToProve2.value'],
    [validation.statToProve2.period, 'statToProve2.period'],
  ]);
  if (badInteger) {
    return err(badInteger);
  }

  const eventStatRoot = bytesFromByteArray(validation.eventStatRoot, 'eventStatRoot');
  if (!eventStatRoot.ok) {
    return eventStatRoot;
  }
  const eventsSubTreeRoot = bytesFromByteArray(
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
