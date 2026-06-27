import { describe, expect, it } from 'vitest';
import { FINAL_GAME_STATES, isFinalGameState } from './score-state.js';

describe('isFinalGameState', () => {
  it('is true for every ended phase: regulation, extra time, and penalties', () => {
    // sourceRef: M0-recon-findings.md O9 (F ended, FET ended after extra time, FPE after penalties).
    for (const finalState of ['F', 'FET', 'FPE']) {
      expect(isFinalGameState(finalState)).toBe(true);
    }
  });

  it('is false for in-running, void, and unknown phases so a bet never settles early', () => {
    for (const liveOrVoidState of ['H1', 'HT', 'H2', 'A', 'C', 'P', 'I', 'TXCC', 'TXCS', '']) {
      expect(isFinalGameState(liveOrVoidState)).toBe(false);
    }
  });

  it('exposes exactly the three ended phases as the final set', () => {
    expect([...FINAL_GAME_STATES].sort()).toEqual(['F', 'FET', 'FPE']);
  });
});
