import { marketKey, type Outcome } from '@txline-agent/core';
import { SystemClock } from '@txline-agent/txline';
import { AgentStateStore } from '@txline-agent/agent';
import { startApiServer } from '@txline-agent/api';

/**
 * Serve the read-only API populated with a REPRESENTATIVE example operator state, so the real
 * dashboard app renders a full, legible view for the README header and the demo video without
 * needing live matches. The decision sides, stakes, and closing-line references are illustrative
 * (the feed pill reads "replay"); the closing-line values are deliberately small (about +0.4pp
 * mean) to match the honest measured edge, not to overstate it. The transaction links are real
 * devnet signatures from this strategy. For the genuine on-chain capture see docs/assets/
 * dashboard-live.png and the README devnet-artifact table.
 *
 * Run: `pnpm --filter @txline-agent/devnet-tools demo:seed` then open the dashboard against
 * http://localhost:8080 (AGENT_API_PORT overrides the port). No .env or wallet needed.
 */

const API_PORT = Number.parseInt(process.env['AGENT_API_PORT'] ?? '8080', 10);

const explorerTx = (signature: string): string =>
  `https://explorer.solana.com/tx/${signature}?cluster=devnet`;

const hex64 = (seed: string): string => seed.repeat(64).slice(0, 64);

type SeedSettle = {
  readonly result: Outcome;
  readonly won: boolean;
  readonly pnlMicroUsd: string;
  readonly clvProb: number;
  readonly settledSeq: number;
  readonly settleSig: string;
  readonly proveSig: string | null;
};

type SeedRow = {
  readonly index: number;
  readonly fixtureId: number;
  readonly outcome: Outcome;
  readonly entryOddsMilli: number;
  readonly fairProb: number;
  readonly stakeMicroUsd: string;
  readonly commitSig: string;
  readonly commitHash: string;
  readonly settle: SeedSettle | null;
};

// Six representative decisions: five settled (three won, two lost) and one still committed; the
// first carries the entry-odds proof (the third trust link). Real devnet signatures from this
// strategy back the links. Small, mixed closing-line values keep the chart honest.
const SEED_ROWS: readonly SeedRow[] = [
  {
    index: 0,
    fixtureId: 17588302,
    outcome: 'home',
    entryOddsMilli: 2100,
    fairProb: 0.5,
    stakeMicroUsd: '25000000',
    commitSig: 'UybuYUc38oqubY99Yxn9xVpkzWRzQEyt17pdQsACGHHnvzFLxtQjnnenWi6TNnaXC6fuMw6CtSj2rvmg3oPDDsA',
    commitHash: hex64('7f3a9c'),
    settle: {
      result: 'home',
      won: true,
      pnlMicroUsd: '27500000',
      clvProb: 0.012,
      settledSeq: 418,
      settleSig: 'SM5ePe8HU5GUWB21vQCEuDGDY5epTH5kAHxvXxvLEhjax2JAXBuwvJ3ugfzxGLonJRJo9Uo92RKM3FZA6feuqFt',
      proveSig: 'Rs9xCY8HzvniHKQgSmwKD3jkw8zc4vQT4PGnTesRGoL8CPfxf82gfYLbaELFsKy85q6wC7sWpJE3x3r63K3AFrh',
    },
  },
  {
    index: 1,
    fixtureId: 17588320,
    outcome: 'away',
    entryOddsMilli: 3400,
    fairProb: 0.31,
    stakeMicroUsd: '22000000',
    commitSig: '32agEtGMd99gCHXtcFxJeR75mxXtSbtQBUah2J39MaEikzLmtP6qTHzQbJyn7gxgXi3AmCJAKuXaLQZB4HJT6Zgp',
    commitHash: hex64('b8d40a'),
    settle: {
      result: 'away',
      won: true,
      pnlMicroUsd: '52800000',
      clvProb: 0.006,
      settledSeq: 502,
      settleSig: '371v6Ln9K7EiVoLHF1H5XDjJDmMkQztwg8FXrSMYNfpnnTXDPmZuBAD7vnaa6HJqUApyVeh57KgLQVYh2ZzC8UnZ',
      proveSig: null,
    },
  },
  {
    index: 2,
    fixtureId: 17588341,
    outcome: 'home',
    entryOddsMilli: 2040,
    fairProb: 0.5,
    stakeMicroUsd: '20000000',
    commitSig: '3UoXtn1v6XWYJeCoQxsNAvryFj6unG2gjvG9ryQSyWRGUuMGtPJWX1iBDpyM97nuRkrHRFHCV9pSBRr3v44AYpuW',
    commitHash: hex64('c31e0d'),
    settle: {
      result: 'away',
      won: false,
      pnlMicroUsd: '-20000000',
      clvProb: -0.005,
      settledSeq: 377,
      settleSig: '5sRtuoPuX1PssB3QAbgDG6ycTaJg2yLAureu2psbECz4nDQR5C3anDXvVYjXywpPY1UKw8ckK3HQusXzJNh2HK6G',
      proveSig: null,
    },
  },
  {
    index: 3,
    fixtureId: 17588355,
    outcome: 'home',
    entryOddsMilli: 2600,
    fairProb: 0.4,
    stakeMicroUsd: '24000000',
    commitSig: '4KfBvDfbG35JWhaezDjhezyYbUbH53hSseJy5o4itPcJ2zgNr7ATVuvq8TqwhDeRqaF5kJU8DddNG2bvYAysRGnN',
    commitHash: hex64('d42af1'),
    settle: {
      result: 'home',
      won: true,
      pnlMicroUsd: '38400000',
      clvProb: 0.009,
      settledSeq: 444,
      settleSig: '4H8XTu6UuLn6XpTS6NNXPdzhy35d5LobBXiwXAX1vdLsro445BEQuMqW4TkjQwSxbQvNzwPvRrqScbYJLkDJ8weh',
      proveSig: null,
    },
  },
  {
    index: 4,
    fixtureId: 17588362,
    outcome: 'away',
    entryOddsMilli: 4200,
    fairProb: 0.22,
    stakeMicroUsd: '19000000',
    commitSig: '2t1yGSgboPECmjAGeRS6j1YJzgqypfYUo8qVaM9t9UHQ4f8cXECsRTNGivCPbwR6vdwsKyR9M563tWSXNNxEzJyS',
    commitHash: hex64('e57b22'),
    settle: {
      result: 'home',
      won: false,
      pnlMicroUsd: '-19000000',
      clvProb: -0.003,
      settledSeq: 461,
      settleSig: '2a6iE7k3ifgZat9RQgQ5msw9vKJgQacsvEWBr2ExJSrd4KbLicJsTZU6bavLh34uYa8RbDmBVh4YFgvxCw2YceDN',
      proveSig: null,
    },
  },
  {
    index: 5,
    fixtureId: 17588377,
    outcome: 'home',
    entryOddsMilli: 2200,
    fairProb: 0.46,
    stakeMicroUsd: '25000000',
    commitSig: '444Qp6eM87PQTjQ1BQQw62grE3eXdsm2CYR5zuV5h84UTqNYRZy8FhKu5S8326B9RN9A7W4nre8LnLUnhh5CuVDH',
    commitHash: hex64('a09f30'),
    settle: null,
  },
];

const seedStore = (store: AgentStateStore): void => {
  store.recordFeedStatus('replay', 'representative example operator view (devnet)');
  for (let eventTick = 0; eventTick < 224; eventTick += 1) {
    store.recordEvent();
  }
  for (const row of SEED_ROWS) {
    store.recordCommit({
      index: row.index,
      onChainIndex: String(40 + row.index),
      commitHash: row.commitHash,
      fixtureId: row.fixtureId,
      marketKey: marketKey({
        fixtureId: row.fixtureId,
        superOddsType: '1X2_PARTICIPANT_RESULT',
        marketPeriod: 'FT',
        marketParameters: '',
      }),
      outcome: row.outcome,
      signalKind: 'cross-market',
      stakeMicroUsd: row.stakeMicroUsd,
      entryOddsMilli: row.entryOddsMilli,
      fairProb: row.fairProb,
      committedAtMs: 1_719_490_000_000 + row.index * 1000,
      txSig: row.commitSig,
      explorerUrl: explorerTx(row.commitSig),
    });
    if (row.settle !== null) {
      store.markSettled(row.index, {
        index: row.index,
        fixtureId: row.fixtureId,
        outcome: row.outcome,
        result: row.settle.result,
        won: row.settle.won,
        pnlMicroUsd: row.settle.pnlMicroUsd,
        settledSeq: row.settle.settledSeq,
        settledAtMs: 1_719_492_000_000 + row.index * 1500,
        closingFairProb: row.fairProb + row.settle.clvProb,
        clvProb: row.settle.clvProb,
        txSig: row.settle.settleSig,
        explorerUrl: explorerTx(row.settle.settleSig),
        entryOddsProven: false,
        oddsProofTxSig: null,
        oddsProofExplorerUrl: null,
      });
      if (row.settle.proveSig !== null) {
        store.markOddsProven(row.index, {
          txSig: row.settle.proveSig,
          explorerUrl: explorerTx(row.settle.proveSig),
        });
      }
    }
  }
};

const main = async (): Promise<void> => {
  const store = new AgentStateStore({ clock: new SystemClock(), startingBankroll: 1_000_000_000n });
  seedStore(store);
  await startApiServer({ store, port: API_PORT, log: (message) => console.log(message) });
  console.log(
    `[seed-dashboard] representative example state live on http://localhost:${API_PORT}. Run \`pnpm --filter @txline-agent/dashboard dev\` and open http://localhost:5173 . Press Ctrl+C to stop.`,
  );
  await new Promise<never>(() => {}); // keep serving until stopped
};

main().catch((error: unknown) => {
  console.error(`[seed-dashboard] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
