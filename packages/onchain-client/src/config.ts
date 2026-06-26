import {
  address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  isAddress,
  type Address,
  type KeyPairSigner,
} from '@solana/kit';
import { err, ok, type Result } from '@txline-agent/core';
import { DEFAULT_COMPUTE_UNIT_LIMIT } from './instruction-build.js';
import { SolanaOnChainPort } from './solana-port.js';

// The deployed agent_ledger program (declare_id! in programs/agent_ledger/src/lib.rs).
const DEFAULT_AGENT_PROGRAM_ID = 'FLZiKMUaPAGMtPLbfHvHwfiVfkTZD8RZ84CSrkDy1kLD';

export type ConfigError = {
  readonly kind: 'missing-env' | 'bad-env' | 'bad-keypair';
  readonly field: string;
  readonly detail: string;
};

export type DevnetConfig = {
  readonly rpcUrl: string;
  readonly rpcSubscriptionsUrl: string;
  readonly keypairPath: string;
  readonly programId: Address;
  readonly txoracleProgramId: Address;
  readonly strategyId: bigint;
  readonly computeUnitLimit: number;
};

export type EnvRecord = Readonly<Record<string, string | undefined>>;

// Solana RPC subscriptions ride a websocket; derive it from the http url when not set.
const websocketUrlFromHttp = (httpUrl: string): string =>
  httpUrl.startsWith('https')
    ? `wss${httpUrl.slice('https'.length)}`
    : httpUrl.startsWith('http')
      ? `ws${httpUrl.slice('http'.length)}`
      : httpUrl;

const requireEnv = (env: EnvRecord, field: string): Result<string, ConfigError> => {
  const value = env[field];
  if (value === undefined || value.length === 0) {
    return err({ kind: 'missing-env', field, detail: `${field} is required` });
  }
  return ok(value);
};

const parseAddress = (value: string, field: string): Result<Address, ConfigError> => {
  if (!isAddress(value)) {
    return err({ kind: 'bad-env', field, detail: `${field} is not a valid base58 address` });
  }
  return ok(address(value));
};

const parseBigintWithDefault = (
  value: string | undefined,
  fallback: bigint,
  field: string,
): Result<bigint, ConfigError> => {
  if (value === undefined || value.length === 0) {
    return ok(fallback);
  }
  try {
    return ok(BigInt(value));
  } catch {
    return err({ kind: 'bad-env', field, detail: `${field} is not an integer` });
  }
};

const parseIntWithDefault = (
  value: string | undefined,
  fallback: number,
  field: string,
): Result<number, ConfigError> => {
  if (value === undefined || value.length === 0) {
    return ok(fallback);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return err({ kind: 'bad-env', field, detail: `${field} must be a positive integer` });
  }
  return ok(parsed);
};

/** Build the devnet config from environment variables, errors as values. */
export const loadDevnetConfig = (env: EnvRecord): Result<DevnetConfig, ConfigError> => {
  const rpcUrl = requireEnv(env, 'SOLANA_RPC_URL');
  if (!rpcUrl.ok) {
    return rpcUrl;
  }
  const keypairPath = requireEnv(env, 'AGENT_KEYPAIR_PATH');
  if (!keypairPath.ok) {
    return keypairPath;
  }
  const txoracleRaw = requireEnv(env, 'TXORACLE_PROGRAM_ID');
  if (!txoracleRaw.ok) {
    return txoracleRaw;
  }
  const programId = parseAddress(env['AGENT_PROGRAM_ID'] ?? DEFAULT_AGENT_PROGRAM_ID, 'AGENT_PROGRAM_ID');
  if (!programId.ok) {
    return programId;
  }
  const txoracleProgramId = parseAddress(txoracleRaw.value, 'TXORACLE_PROGRAM_ID');
  if (!txoracleProgramId.ok) {
    return txoracleProgramId;
  }
  const strategyId = parseBigintWithDefault(env['STRATEGY_ID'], 0n, 'STRATEGY_ID');
  if (!strategyId.ok) {
    return strategyId;
  }
  const computeUnitLimit = parseIntWithDefault(
    env['COMPUTE_UNIT_LIMIT'],
    DEFAULT_COMPUTE_UNIT_LIMIT,
    'COMPUTE_UNIT_LIMIT',
  );
  if (!computeUnitLimit.ok) {
    return computeUnitLimit;
  }
  return ok({
    rpcUrl: rpcUrl.value,
    rpcSubscriptionsUrl: env['SOLANA_RPC_SUBSCRIPTIONS_URL'] ?? websocketUrlFromHttp(rpcUrl.value),
    keypairPath: keypairPath.value,
    programId: programId.value,
    txoracleProgramId: txoracleProgramId.value,
    strategyId: strategyId.value,
    computeUnitLimit: computeUnitLimit.value,
  });
};

/**
 * Load the agent authority signer from a Solana CLI keypair file (a JSON array of 64
 * bytes). The file read is injected so this stays free of a node:fs import and testable.
 */
export const loadKeypairSigner = async (
  readFileText: (path: string) => Promise<string>,
  keypairPath: string,
): Promise<Result<KeyPairSigner, ConfigError>> => {
  let text: string;
  try {
    text = await readFileText(keypairPath);
  } catch (readError) {
    return err({
      kind: 'bad-keypair',
      field: 'AGENT_KEYPAIR_PATH',
      detail: `cannot read keypair file: ${readError instanceof Error ? readError.message : String(readError)}`,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err({ kind: 'bad-keypair', field: 'AGENT_KEYPAIR_PATH', detail: 'keypair file is not valid JSON' });
  }
  if (!Array.isArray(parsed) || parsed.length !== 64 || !parsed.every((byte) => typeof byte === 'number')) {
    return err({
      kind: 'bad-keypair',
      field: 'AGENT_KEYPAIR_PATH',
      detail: 'keypair file must be a JSON array of 64 byte values',
    });
  }
  try {
    const signer = await createKeyPairSignerFromBytes(Uint8Array.from(parsed));
    return ok(signer);
  } catch (keyError) {
    return err({
      kind: 'bad-keypair',
      field: 'AGENT_KEYPAIR_PATH',
      detail: `invalid ed25519 keypair: ${keyError instanceof Error ? keyError.message : String(keyError)}`,
    });
  }
};

/** Construct a live SolanaOnChainPort from a loaded config and authority signer. */
export const createDevnetPort = (config: DevnetConfig, authority: KeyPairSigner): SolanaOnChainPort =>
  new SolanaOnChainPort({
    rpc: createSolanaRpc(config.rpcUrl),
    rpcSubscriptions: createSolanaRpcSubscriptions(config.rpcSubscriptionsUrl),
    authority,
    programId: config.programId,
    txoracleProgramId: config.txoracleProgramId,
    strategyId: config.strategyId,
    computeUnitLimit: config.computeUnitLimit,
  });
