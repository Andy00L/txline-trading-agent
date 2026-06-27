/**
 * Soccer game-phase strings and the settlement predicate over them.
 *
 * sourceRef: docs/research/M0-recon-findings.md O9 (CONFIRMED). The soccer feed numbers
 * game phases 1..19; the "ended" phases (settle-eligible) are 5 F, 10 FET (ended after
 * extra time), 13 FPE (ended after penalties). The live 2026-06-26 capture carried the
 * string form ('F'), so these are the game-state strings, not the numeric ids. The void
 * phases (14 I interrupted, 15 A abandoned, 16 C cancelled, 17 TXCC, 18 TXCS, 19 P
 * postponed) are noted here for reference; void handling is not wired in the agent yet.
 */

// Game-state strings that mark a final, settle-eligible result: ended in regulation (F),
// after extra time (FET), or after penalties (FPE). sourceRef: M0-recon-findings.md O9.
export const FINAL_GAME_STATES: ReadonlySet<string> = new Set(['F', 'FET', 'FPE']);

/**
 * True when a score update's game state marks the match as finally ended, so the open
 * positions on that fixture can be settled against the now-final score. Returns false for
 * in-running phases (H1, HT, H2, ...) so an in-play snapshot never settles a bet early
 * (A-9: the chosen score must be the final one, not an in-running one).
 */
export const isFinalGameState = (gameState: string): boolean => FINAL_GAME_STATES.has(gameState);

/**
 * The numeric soccer StatusId to its game-state string, per the soccer-feed phase numbering.
 * The `/updates` (replay) feed freezes the textual GameState at "scheduled" and carries the
 * real phase only in the numeric StatusId (confirmed from the fixture-status probe 2026-06-27:
 * StatusId runs 2 H1 -> 3 HT -> 4 H2 -> 5 F while GameState stays "scheduled"), so the canonical
 * phase string is derived from StatusId. sourceRef: docs/research/M0-recon-findings.md O9.
 */
const GAME_STATE_BY_STATUS_ID: ReadonlyMap<number, string> = new Map([
  [1, 'NS'],
  [2, 'H1'],
  [3, 'HT'],
  [4, 'H2'],
  [5, 'F'],
  [6, 'WET'],
  [7, 'ET1'],
  [8, 'HTET'],
  [9, 'ET2'],
  [10, 'FET'],
  [11, 'WPE'],
  [12, 'PE'],
  [13, 'FPE'],
  [14, 'I'],
  [15, 'A'],
  [16, 'C'],
  [17, 'TXCC'],
  [18, 'TXCS'],
  [19, 'P'],
]);

/**
 * Resolve the canonical game-state string from the numeric StatusId, falling back to the wire
 * GameState string when StatusId is absent or unknown. This is what makes settlement work on the
 * replay feed, where StatusId (not GameState) carries the final-whistle transition.
 */
export const gameStateFromStatusId = (statusId: number | null, fallbackGameState: string): string =>
  statusId === null ? fallbackGameState : (GAME_STATE_BY_STATUS_ID.get(statusId) ?? fallbackGameState);
