import type { SseChannel, SseConnector, TaggedFrame } from '../feed/live.js';
import { SseFrameParser } from '../feed/sse-parse.js';

/**
 * Live SSE transport for LiveSseFeed. TxLINE serves odds and scores on two separate
 * Server-Sent Events endpoints (/api/odds/stream and /api/scores/stream); this connector
 * opens both, tags each parsed frame with its channel, and merges them into the single
 * AsyncIterable the feed expects. A drop or non-2xx on either stream ends the iterable
 * (with an error), which LiveSseFeed turns into a backoff reconnect plus REST gap-backfill.
 *
 * fetch and its byte stream are injected through FetchLike so the merge logic is unit
 * testable without a network. Auth headers mirror TxlineClient (Authorization: Bearer
 * {jwt}, X-Api-Token: {api_token}). sourceRef: docs/BUILD_PLAN.md (LiveSseFeed transport),
 * http/client.ts (authHeaders).
 */

export type SseAuth = { readonly jwt: string; readonly apiToken: string };

// The minimal fetch surface the connector needs, so a test can inject a fake without
// pulling in DOM lib types. The body is an async-iterable of byte chunks, or null.
export type SseFetchInit = { readonly headers: Record<string, string>; readonly signal: AbortSignal };
export type SseFetchResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly body: AsyncIterable<Uint8Array> | null;
};
export type FetchLike = (url: string, init: SseFetchInit) => Promise<SseFetchResponse>;

// Structural view of a web ReadableStream reader, so the default adapter does not depend on
// the global ReadableStream type name (it differs between the DOM and node:stream/web libs).
type ByteStreamReader = {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>;
  releaseLock(): void;
};
type ByteStream = { getReader(): ByteStreamReader };

/** Adapt a web ReadableStream (the shape Node's fetch Response.body has) into a plain
 * async-iterable of byte chunks, releasing the reader lock on completion or error. */
async function* readByteStream(stream: ByteStream): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      if (value !== undefined) {
        yield value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** The default FetchLike: the global fetch (Node 22 undici), with its Response.body read
 * through getReader so this does not assume the body is directly async-iterable. */
const defaultFetch: FetchLike = async (url, init) => {
  const response = await fetch(url, { headers: init.headers, signal: init.signal });
  return {
    ok: response.ok,
    status: response.status,
    body: response.body === null ? null : readByteStream(response.body),
  };
};

export type FetchSseConnectorDeps = {
  readonly dataBaseUrl: string; // e.g. https://txline-dev.txodds.com
  readonly auth: SseAuth;
  /** Injected for tests; defaults to the global fetch. */
  readonly fetchImpl?: FetchLike;
};

export class FetchSseConnector implements SseConnector {
  private readonly dataBaseUrl: string;
  private readonly auth: SseAuth;
  private readonly fetchImpl: FetchLike;

  constructor(deps: FetchSseConnectorDeps) {
    this.dataBaseUrl = deps.dataBaseUrl;
    this.auth = deps.auth;
    this.fetchImpl = deps.fetchImpl ?? defaultFetch;
  }

  private headers(lastEventId: string | null): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      Authorization: `Bearer ${this.auth.jwt}`,
      'X-Api-Token': this.auth.apiToken,
    };
    if (lastEventId !== null) {
      // The two channels have independent id spaces, so this is a best-effort resume; the
      // REST gap-backfill on reconnect is the real safety net for missed events.
      headers['Last-Event-ID'] = lastEventId;
    }
    return headers;
  }

  async *connect(lastEventId: string | null): AsyncIterable<TaggedFrame> {
    const controller = new AbortController();
    const headers = this.headers(lastEventId);
    const queue: TaggedFrame[] = [];
    let wake: (() => void) | null = null;
    let finishedPumps = 0;
    let failure: unknown = null;

    const notify = (): void => {
      if (wake !== null) {
        const resume = wake;
        wake = null;
        resume();
      }
    };

    const pump = async (channel: SseChannel, url: string): Promise<void> => {
      try {
        const response = await this.fetchImpl(url, { headers, signal: controller.signal });
        if (!response.ok || response.body === null) {
          throw new Error(`[FetchSseConnector] ${channel} stream HTTP ${response.status}`);
        }
        const parser = new SseFrameParser();
        const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          const frames = parser.push(decoder.decode(chunk, { stream: true }));
          for (const frame of frames) {
            queue.push({ channel, frame });
          }
          if (frames.length > 0) {
            notify();
          }
        }
      } catch (streamError) {
        if (failure === null) {
          failure = streamError;
        }
      } finally {
        finishedPumps += 1;
        notify();
      }
    };

    const pumps = [
      pump('odds', `${this.dataBaseUrl}/api/odds/stream`),
      pump('scores', `${this.dataBaseUrl}/api/scores/stream`),
    ];

    try {
      for (;;) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (finishedPumps >= pumps.length) {
          break;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      if (failure !== null) {
        throw failure instanceof Error ? failure : new Error(String(failure));
      }
    } finally {
      // Stop the still-open stream when the consumer breaks (LiveSseFeed.stop or a thrown
      // failure from the sibling stream), and wait for both pumps to unwind.
      controller.abort();
      await Promise.allSettled(pumps);
    }
  }
}
