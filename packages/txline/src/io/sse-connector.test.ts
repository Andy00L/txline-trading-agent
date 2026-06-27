import { describe, expect, it } from 'vitest';
import type { SseResumeIds, TaggedFrame } from '../feed/live.js';
import { FetchSseConnector, type FetchLike, type SseFetchResponse } from './sse-connector.js';

const encoder = new TextEncoder();

async function* bytesOf(chunks: readonly string[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) {
    yield encoder.encode(chunk);
  }
}

const streaming = (chunks: readonly string[]): SseFetchResponse => ({
  ok: true,
  status: 200,
  body: bytesOf(chunks),
});

const NO_RESUME: SseResumeIds = { odds: null, scores: null };

const collect = async (
  connector: FetchSseConnector,
  resume: SseResumeIds = NO_RESUME,
): Promise<TaggedFrame[]> => {
  const frames: TaggedFrame[] = [];
  for await (const tagged of connector.connect(resume)) {
    frames.push(tagged);
  }
  return frames;
};

describe('FetchSseConnector', () => {
  it('opens both streams and merges their frames tagged by channel', async () => {
    const openedUrls: string[] = [];
    const fetchImpl: FetchLike = async (url, _init) => {
      openedUrls.push(url);
      if (url.endsWith('/api/odds/stream')) {
        return streaming([
          'id: 1\nevent: odds\ndata: {"FixtureId":1}\n\n',
          'id: 2\nevent: odds\ndata: {"FixtureId":2}\n\n',
        ]);
      }
      return streaming(['id: 9\nevent: scores\ndata: {"FixtureId":1}\n\n']);
    };
    const connector = new FetchSseConnector({
      dataBaseUrl: 'https://txline-dev.txodds.com',
      auth: { jwt: 'jwt-x', apiToken: 'tok-y' },
      fetchImpl,
    });

    const frames = await collect(connector);
    const odds = frames.filter((tagged) => tagged.channel === 'odds');
    const scores = frames.filter((tagged) => tagged.channel === 'scores');

    expect(odds).toHaveLength(2);
    expect(scores).toHaveLength(1);
    // Order is preserved within a channel even though the two streams are merged.
    expect(odds[0]?.frame.data).toBe('{"FixtureId":1}');
    expect(odds[1]?.frame.data).toBe('{"FixtureId":2}');
    expect(scores[0]?.frame.event).toBe('scores');
    expect([...openedUrls].sort()).toEqual([
      'https://txline-dev.txodds.com/api/odds/stream',
      'https://txline-dev.txodds.com/api/scores/stream',
    ]);
  });

  it('sends the auth headers and a Last-Event-ID on resume', async () => {
    let captured: Record<string, string> = {};
    const fetchImpl: FetchLike = async (_url, init) => {
      captured = init.headers;
      return streaming([]); // empty stream ends immediately
    };
    const connector = new FetchSseConnector({
      dataBaseUrl: 'https://d',
      auth: { jwt: 'J', apiToken: 'T' },
      fetchImpl,
    });

    await collect(connector, { odds: 'evt-42', scores: 'evt-42' });

    expect(captured['Authorization']).toBe('Bearer J');
    expect(captured['X-Api-Token']).toBe('T');
    expect(captured['Accept']).toBe('text/event-stream');
    expect(captured['Last-Event-ID']).toBe('evt-42');
  });

  it('omits Last-Event-ID on the first connection', async () => {
    let captured: Record<string, string> = {};
    const fetchImpl: FetchLike = async (_url, init) => {
      captured = init.headers;
      return streaming([]);
    };
    const connector = new FetchSseConnector({
      dataBaseUrl: 'https://d',
      auth: { jwt: 'J', apiToken: 'T' },
      fetchImpl,
    });

    await collect(connector);

    expect('Last-Event-ID' in captured).toBe(false);
  });

  it('resumes each channel from its own last id (C3)', async () => {
    const seen: Record<string, string | undefined> = {};
    const fetchImpl: FetchLike = async (url, init) => {
      const channel = url.endsWith('/api/odds/stream') ? 'odds' : 'scores';
      seen[channel] = init.headers['Last-Event-ID'];
      return streaming([]);
    };
    const connector = new FetchSseConnector({
      dataBaseUrl: 'https://d',
      auth: { jwt: 'J', apiToken: 'T' },
      fetchImpl,
    });

    await collect(connector, { odds: 'odds-7', scores: 'scores-9' });

    expect(seen['odds']).toBe('odds-7');
    expect(seen['scores']).toBe('scores-9');
  });

  it('throws when a stream returns a non-2xx status, so the feed reconnects', async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.endsWith('/api/odds/stream')) {
        return { ok: false, status: 503, body: null };
      }
      return streaming([]);
    };
    const connector = new FetchSseConnector({
      dataBaseUrl: 'https://d',
      auth: { jwt: 'J', apiToken: 'T' },
      fetchImpl,
    });

    await expect(collect(connector)).rejects.toThrow('503');
  });
});
