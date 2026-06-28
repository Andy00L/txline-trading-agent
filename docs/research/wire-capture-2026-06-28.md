# Live wire capture, 2026-06-28 (schema and finality ground-truth)

A direct probe of the live TxLINE data API (bypassing our own zod parser) to confirm the
on-the-wire field casing and the finality encoding, against the public-docs prose. This backs
two claims in [the submission technical doc](../submission/TECHNICAL.md): that the scores
channel is PascalCase, and that on the `/updates` and snapshot feeds the textual `GameState` is
frozen while the real phase lives in the numeric `StatusId`.

Request (headers carry the JWT and api-token, never shown):

```
GET https://txline-dev.txodds.com/api/scores/snapshot/17588302
Authorization: Bearer <jwt>
X-Api-Token: <api-token>
-> HTTP 200, a JSON array of 38 records
```

First record, trimmed (the full `Stats` map and per-period `Score` blocks are abbreviated):

```json
{
  "FixtureId": 17588302,
  "GameState": "scheduled",
  "StartTime": 1782417600000,
  "CompetitionId": 72,
  "SportId": 1,
  "Participant1IsHome": true,
  "Participant1Id": 1892,
  "Participant2Id": 2039,
  "Ts": 1782423648642,
  "Seq": 804,
  "StatusId": 4,
  "Type": "Soccer",
  "Clock": { "Running": true, "Seconds": 4796 },
  "Score": {
    "Participant1": { "Total": { "Goals": 2, "YellowCards": 2, "Corners": 3 } },
    "Participant2": { "Total": { "Goals": 1, "YellowCards": 1, "Corners": 1 } }
  },
  "Stats": { "1001": 1, "8": 1, "1003": 1, "1004": 1 }
}
```

## What it confirms

- The scores channel is PascalCase on the wire (`FixtureId`, `GameState`, `StartTime`,
  `Participant1IsHome`, `Seq`, `StatusId`, `Score`, `Stats`), matching
  `packages/txline/src/schemas/scores.ts`. The public-docs prose describes camelCase, which the
  live feed does not match. Our schema is correct; the docs lag the feed.
- The World Cup `CompetitionId` is `72`, here as a literal field on a live record (previously
  stated as confirmed by trial).
- Finality is in the numeric `StatusId` (here `4`, second half), while the textual `GameState`
  is `"scheduled"` on the same record. Settlement that keys on `GameState` would never fire;
  keying on `StatusId` (the path the agent uses) is required. This is the single most costly
  surprise documented in the API feedback, reproduced here against a live record.

## Reproduce

`node --env-file=.env` against the data host with the World Cup api-token, requesting
`/api/scores/snapshot/{fixtureId}` for a covered fixture, then read the raw record keys before
any schema parse. The `.env` (gitignored) holds `TXLINE_DATA_BASE_URL`, `TXLINE_JWT`, and
`TXLINE_API_TOKEN`.
