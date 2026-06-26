import { describe, expect, it } from 'vitest';
import {
  COMMIT_DECISION_DISCRIMINATOR,
  INITIALIZE_STRATEGY_DISCRIMINATOR,
  SETTLE_DECISION_DISCRIMINATOR,
  VALIDATE_STAT_DISCRIMINATOR,
  VOID_DECISION_DISCRIMINATOR,
} from './discriminators.js';

describe('anchor discriminators', () => {
  it('matches the published validate_stat discriminator', () => {
    // sourceRef: txoracle IDL (docs/research/M0-recon-findings.md). Matching this
    // proves the sha256("global:<name>") computation is correct for every instruction.
    expect(Array.from(VALIDATE_STAT_DISCRIMINATOR)).toEqual([
      107, 197, 232, 90, 191, 136, 105, 185,
    ]);
  });

  it('produces a distinct 8-byte discriminator per agent_ledger instruction', () => {
    const all = [
      INITIALIZE_STRATEGY_DISCRIMINATOR,
      COMMIT_DECISION_DISCRIMINATOR,
      SETTLE_DECISION_DISCRIMINATOR,
      VOID_DECISION_DISCRIMINATOR,
    ];
    for (const discriminator of all) {
      expect(discriminator).toHaveLength(8);
    }
    const distinct = new Set(all.map((discriminator) => Array.from(discriminator).join(',')));
    expect(distinct.size).toBe(all.length);
  });
});
