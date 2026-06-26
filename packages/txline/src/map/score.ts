import { ok, type Result, type ScoreUpdate } from '@txline-agent/core';
import type { ScoresPayload } from '../schemas/scores.js';
import type { MapError } from './error.js';

// Full-game goal stat keys (period 0). sourceRef: docs/research/M0-recon-findings.md A-3.
const FULL_GAME_PARTICIPANT1_GOALS = 1;
const FULL_GAME_PARTICIPANT2_GOALS = 2;

/**
 * Map a raw scores payload to a normalized ScoreUpdate. The stats map is reindexed
 * by numeric key; home and away goals are derived from the participant goal stats
 * using participant1IsHome, or null when those stats are absent.
 */
export const mapScorePayload = (raw: ScoresPayload): Result<ScoreUpdate, MapError> => {
  const stats = new Map<number, number>();
  if (raw.stats) {
    for (const [rawKey, value] of Object.entries(raw.stats)) {
      const numericKey = Number(rawKey);
      if (Number.isInteger(numericKey)) {
        stats.set(numericKey, value);
      }
    }
  }

  const participant1Goals = stats.get(FULL_GAME_PARTICIPANT1_GOALS) ?? null;
  const participant2Goals = stats.get(FULL_GAME_PARTICIPANT2_GOALS) ?? null;
  const homeGoals = raw.participant1IsHome ? participant1Goals : participant2Goals;
  const awayGoals = raw.participant1IsHome ? participant2Goals : participant1Goals;

  return ok({
    fixtureId: raw.fixtureId,
    seq: raw.seq,
    tsMs: raw.ts,
    gameState: raw.gameState,
    participant1IsHome: raw.participant1IsHome,
    homeGoals,
    awayGoals,
    stats,
  });
};
