import { ok, type FixtureUpdate, type Result } from '@txline-agent/core';
import type { Fixture } from '../schemas/fixtures.js';
import type { MapError } from './error.js';

/** Map a raw fixture record to a normalized FixtureUpdate. */
export const mapFixturePayload = (raw: Fixture): Result<FixtureUpdate, MapError> =>
  ok({
    fixtureId: raw.FixtureId,
    tsMs: raw.Ts,
    startTimeMs: raw.StartTime,
    competition: raw.Competition,
    competitionId: raw.CompetitionId,
    participant1Id: raw.Participant1Id,
    participant1: raw.Participant1,
    participant2Id: raw.Participant2Id,
    participant2: raw.Participant2,
    participant1IsHome: raw.Participant1IsHome,
  });
