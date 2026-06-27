import { ok, type Result, type ScoreUpdate } from '@txline-agent/core';
import type { ScoresPayload } from '../schemas/scores.js';
import type { MapError } from './error.js';

// Full-game goal stat keys (period 0). sourceRef: docs/research/M0-recon-findings.md A-3.
const FULL_GAME_PARTICIPANT1_GOALS = 1;
const FULL_GAME_PARTICIPANT2_GOALS = 2;

/**
 * Map a raw scores payload to a normalized ScoreUpdate. The stats map is reindexed by numeric
 * key. The trust chain is participant-space: "home" goals are participant 1 goals and "away"
 * goals are participant 2 goals (stat keys 1 and 2), matching the participant-indexed on-chain
 * settle proof; participant1IsHome is carried through for display only and never flips the
 * result (a flip would diverge from the on-chain record). Goals are null when those stats are
 * absent. sourceRef: docs/audit/M8-audit.md.
 */
export const mapScorePayload = (raw: ScoresPayload): Result<ScoreUpdate, MapError> => {
  const stats = new Map<number, number>();
  if (raw.Stats) {
    for (const [rawKey, value] of Object.entries(raw.Stats)) {
      // Only accept a canonical non-negative decimal key. Number() would coerce '' to 0, '0x10'
      // to 16, and '1e3' to 1000, inserting values under unintended keys; a strict pattern avoids it.
      if (/^\d+$/.test(rawKey)) {
        stats.set(Number(rawKey), value);
      }
    }
  }

  // Participant-space: home = participant 1 goals, away = participant 2 goals, with no flip by
  // participant1IsHome. The on-chain settle pins the predicate to participant 1 vs participant 2
  // goals (stat keys 1 and 2), so flipping here would silently diverge the off-chain books from
  // the on-chain record for fixtures where participant1IsHome is false.
  const homeGoals = stats.get(FULL_GAME_PARTICIPANT1_GOALS) ?? null;
  const awayGoals = stats.get(FULL_GAME_PARTICIPANT2_GOALS) ?? null;

  return ok({
    fixtureId: raw.FixtureId,
    seq: raw.Seq,
    tsMs: raw.Ts,
    gameState: raw.GameState ?? '',
    participant1IsHome: raw.Participant1IsHome,
    homeGoals,
    awayGoals,
    stats,
  });
};
