import { describe, expect, it } from 'vitest';
import { SeededPrng } from '@txline-agent/core';
import { TxlineClient, type TxlineClientDeps } from './client.js';
import type { HttpClient, HttpRequest, HttpResponse } from './types.js';

const validOddsRaw = {
  FixtureId: 17588227,
  MessageId: 'm',
  Ts: 1750000000000,
  Bookmaker: 'StablePrice',
  BookmakerId: 0,
  SuperOddsType: 'StablePrice',
  InRunning: false,
  PriceNames: ['1', 'X', '2'],
  Prices: [2100, 3400, 3600],
  Pct: ['47.619', '29.412', '27.778'],
};

const validProof = {
  ts: 1750000200000,
  statToProve: { key: 1, value: 2, period: 0 },
  eventStatRoot: 'aa',
  summary: {
    fixtureId: 17588227,
    updateStats: { updateCount: 5, minTimestamp: 1750000000000, maxTimestamp: 1750000300000 },
    eventStatsSubTreeRoot: 'bb',
  },
  statProof: [{ hash: 'cc', isRightSibling: true }],
  subTreeProof: null,
  mainTreeProof: null,
  statToProve2: { key: 2, value: 1, period: 0 },
  statProof2: [{ hash: 'ee', isRightSibling: false }],
};

class MockHttp implements HttpClient {
  public readonly sent: HttpRequest[] = [];
  private readonly queue: (HttpResponse | Error)[];

  constructor(queue: readonly (HttpResponse | Error)[]) {
    this.queue = [...queue];
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    this.sent.push(request);
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error('mock: no queued response');
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}

const makeDeps = (http: HttpClient, sleeps?: number[]): TxlineClientDeps => ({
  http,
  sleep: async (ms: number) => {
    sleeps?.push(ms);
  },
  prng: new SeededPrng(1),
  dataBaseUrl: 'https://data',
  authBaseUrl: 'https://auth',
  backoff: { baseMs: 10, maxMs: 100, maxAttempts: 3 },
});

const auth = { jwt: 'jay', apiToken: 'tok' };

describe('TxlineClient', () => {
  it('sends auth headers and parses a successful response', async () => {
    const http = new MockHttp([{ status: 200, body: JSON.stringify([validOddsRaw]) }]);
    const client = new TxlineClient(makeDeps(http), auth);
    const result = await client.getOddsUpdates(20000, 15, 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
    }
    expect(http.sent[0]?.url).toContain('/api/odds/updates/20000/15/0');
    expect(http.sent[0]?.headers['Authorization']).toBe('Bearer jay');
    expect(http.sent[0]?.headers['X-Api-Token']).toBe('tok');
  });

  it('refreshes the JWT once on 401 and retries', async () => {
    const http = new MockHttp([
      { status: 401, body: 'expired' },
      { status: 200, body: JSON.stringify({ token: 'fresh' }) },
      { status: 200, body: JSON.stringify([validOddsRaw]) },
    ]);
    const client = new TxlineClient(makeDeps(http), { jwt: 'stale', apiToken: 'tok' });
    const result = await client.getOddsUpdates(20000, 15, 0);
    expect(result.ok).toBe(true);
    expect(http.sent).toHaveLength(3);
    expect(http.sent[1]?.url).toContain('/auth/guest/start');
    expect(http.sent[2]?.headers['Authorization']).toBe('Bearer fresh');
  });

  it('retries a 429 with a backoff sleep, then succeeds', async () => {
    const sleeps: number[] = [];
    const http = new MockHttp([
      { status: 429, body: 'slow down' },
      { status: 200, body: JSON.stringify([validOddsRaw]) },
    ]);
    const client = new TxlineClient(makeDeps(http, sleeps), auth);
    const result = await client.getOddsSnapshot(17588227);
    expect(result.ok).toBe(true);
    expect(sleeps).toHaveLength(1);
    expect(http.sent).toHaveLength(2);
  });

  it('retries a transport failure, then succeeds', async () => {
    const sleeps: number[] = [];
    const http = new MockHttp([
      new Error('ECONNRESET'),
      { status: 200, body: JSON.stringify([validOddsRaw]) },
    ]);
    const client = new TxlineClient(makeDeps(http, sleeps), auth);
    const result = await client.getOddsSnapshot(17588227, 1750000000000);
    expect(result.ok).toBe(true);
    expect(sleeps).toHaveLength(1);
  });

  it('returns a distinct not-found error', async () => {
    const http = new MockHttp([{ status: 404, body: 'nope' }]);
    const client = new TxlineClient(makeDeps(http), auth);
    const result = await client.getOddsUpdates(20000, 15, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('not-found');
    }
  });

  it('gives up after maxAttempts of 5xx with a server-error', async () => {
    const http = new MockHttp([
      { status: 503, body: 'a' },
      { status: 503, body: 'b' },
      { status: 503, body: 'c' },
    ]);
    const client = new TxlineClient(makeDeps(http), auth);
    const result = await client.getOddsUpdates(20000, 15, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('server-error');
    }
    expect(http.sent).toHaveLength(3);
  });

  it('returns a parse error on invalid JSON', async () => {
    const http = new MockHttp([{ status: 200, body: 'not json' }]);
    const client = new TxlineClient(makeDeps(http), auth);
    const result = await client.getOddsUpdates(20000, 15, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('parse');
    }
  });

  it('builds the two-stat validation URL and parses the proof', async () => {
    const http = new MockHttp([{ status: 200, body: JSON.stringify(validProof) }]);
    const client = new TxlineClient(makeDeps(http), auth);
    const result = await client.getScoresStatValidation({
      fixtureId: 17588227,
      seq: 401,
      statKey: 1,
      statKey2: 2,
    });
    expect(result.ok).toBe(true);
    expect(http.sent[0]?.url).toContain('fixtureId=17588227&seq=401&statKey=1&statKey2=2');
  });
});
