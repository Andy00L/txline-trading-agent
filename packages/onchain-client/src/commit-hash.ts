import { keccak_256 } from '@noble/hashes/sha3';
import { ok, type Result } from '@txline-agent/core';
import { encodeRevealArgs, type EncodeError, type RevealArgs } from './borsh.js';

/**
 * commit_hash = keccak256(borsh(RevealArgs)). This must be byte-identical to the
 * on-chain compute_commit_hash; the program rejects a settle whose recomputed hash
 * does not match the committed one. sourceRef: programs/agent_ledger/src/logic.rs.
 */
export const computeCommitHash = (reveal: RevealArgs): Result<Uint8Array, EncodeError> => {
  const encoded = encodeRevealArgs(reveal);
  if (!encoded.ok) {
    return encoded;
  }
  return ok(keccak_256(encoded.value));
};
