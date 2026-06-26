import { sha256 } from '@noble/hashes/sha256';

/**
 * Anchor instruction discriminator: the first 8 bytes of sha256("global:<name>").
 * Derived from the instruction name, so it is stable across IDL versions. The
 * validate_stat value is cross-checked against the published IDL in the tests, which
 * confirms this computation matches Anchor's for every instruction.
 */
export const anchorDiscriminator = (name: string): Uint8Array =>
  sha256(new TextEncoder().encode(`global:${name}`)).slice(0, 8);

export const INITIALIZE_STRATEGY_DISCRIMINATOR = anchorDiscriminator('initialize_strategy');
export const COMMIT_DECISION_DISCRIMINATOR = anchorDiscriminator('commit_decision');
export const SETTLE_DECISION_DISCRIMINATOR = anchorDiscriminator('settle_decision');
export const VOID_DECISION_DISCRIMINATOR = anchorDiscriminator('void_decision');

// The txoracle CPI target. Its value is the golden that validates this whole module.
export const VALIDATE_STAT_DISCRIMINATOR = anchorDiscriminator('validate_stat');
