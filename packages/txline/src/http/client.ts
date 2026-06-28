import { z } from 'zod';
import { err, ok, type Prng, type Result } from '@txline-agent/core';
import { parseWith } from '../parse.js';
import { oddsPayloadSchema, type OddsPayload } from '../schemas/odds.js';
import { scoresPayloadSchema, type ScoresPayload } from '../schemas/scores.js';
import {
  oddsValidationSchema,
  scoresStatValidationSchema,
  type OddsValidation,
  type ScoresStatValidation,
} from '../schemas/proof.js';
import { computeBackoffMs, DEFAULT_BACKOFF, type BackoffConfig } from './backoff.js';
import type { HttpClient, HttpRequest, HttpResponse, TxlineError, TxlineErrorKind } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

const authTokenSchema = z.object({ token: z.string() });

export type TxlineAuth = { readonly jwt: string; readonly apiToken: string };

export type TxlineClientDeps = {
  readonly http: HttpClient;
  /** Injected so retries do not actually block in tests. */
  readonly sleep: (ms: number) => Promise<void>;
  readonly prng: Prng;
  readonly dataBaseUrl: string; // e.g. https://txline-dev.txodds.com
  readonly authBaseUrl: string; // e.g. https://oracle-dev.txodds.com
  readonly timeoutMs?: number;
  readonly backoff?: BackoffConfig;
};

const messageOf = (value: unknown): string =>
  value instanceof Error ? value.message : String(value);

const classifyStatus = (status: number, body: string): TxlineError => {
  const detail = body.slice(0, 200);
  let kind: TxlineErrorKind = 'bad-status';
  if (status === 401) {
    kind = 'unauthorized';
  } else if (status === 403) {
    kind = 'forbidden';
  } else if (status === 404) {
    kind = 'not-found';
  } else if (status === 429) {
    kind = 'rate-limited';
  } else if (status >= 500) {
    kind = 'server-error';
  }
  return { kind, status, detail };
};

const parseJson = <TSchema extends z.ZodTypeAny>(
  body: string,
  schema: TSchema,
): Result<z.infer<TSchema>, TxlineError> => {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return err({ kind: 'parse', status: null, detail: 'response body was not valid JSON' });
  }
  const parsed = parseWith(schema, json);
  if (!parsed.ok) {
    return err({
      kind: 'parse',
      status: null,
      detail: `${parsed.error.field}: ${parsed.error.message}`,
    });
  }
  return ok(parsed.value);
};

/**
 * Typed TxLINE REST client with resilience: exponential backoff plus full jitter on
 * transient failures (429, 5xx, transport), one JWT re-auth on 401, distinct errors
 * per failure mode, and zod parsing at every ingress. All methods return Results.
 */
export class TxlineClient {
  private readonly http: HttpClient;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly prng: Prng;
  private readonly dataBaseUrl: string;
  private readonly authBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly backoff: BackoffConfig;
  private auth: TxlineAuth;

  constructor(deps: TxlineClientDeps, auth: TxlineAuth = { jwt: '', apiToken: '' }) {
    this.http = deps.http;
    this.sleep = deps.sleep;
    this.prng = deps.prng;
    this.dataBaseUrl = deps.dataBaseUrl;
    this.authBaseUrl = deps.authBaseUrl;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.backoff = deps.backoff ?? DEFAULT_BACKOFF;
    this.auth = auth;
  }

  setAuth(auth: TxlineAuth): void {
    this.auth = auth;
  }

  /** Start a guest session and store the returned 30-day JWT. */
  async startGuestSession(): Promise<Result<string, TxlineError>> {
    const request: HttpRequest = {
      method: 'POST',
      url: `${this.authBaseUrl}/auth/guest/start`,
      headers: { 'Content-Type': 'application/json' },
      timeoutMs: this.timeoutMs,
    };
    const response = await this.sendWithRetry(request, false);
    if (!response.ok) {
      return response;
    }
    const parsed = parseJson(response.value.body, authTokenSchema);
    if (!parsed.ok) {
      return parsed;
    }
    this.auth = { ...this.auth, jwt: parsed.value.token };
    return ok(parsed.value.token);
  }

  async getOddsUpdates(
    epochDay: number,
    hourOfDay: number,
    interval: number,
  ): Promise<Result<readonly OddsPayload[], TxlineError>> {
    return this.getJson(
      `${this.dataBaseUrl}/api/odds/updates/${epochDay}/${hourOfDay}/${interval}`,
      z.array(oddsPayloadSchema),
    );
  }

  async getScoresUpdates(
    epochDay: number,
    hourOfDay: number,
    interval: number,
  ): Promise<Result<readonly ScoresPayload[], TxlineError>> {
    return this.getJson(
      `${this.dataBaseUrl}/api/scores/updates/${epochDay}/${hourOfDay}/${interval}`,
      z.array(scoresPayloadSchema),
    );
  }

  async getOddsSnapshot(
    fixtureId: number,
    asOfMs?: number,
  ): Promise<Result<readonly OddsPayload[], TxlineError>> {
    const query = asOfMs === undefined ? '' : `?asOf=${asOfMs}`;
    return this.getJson(
      `${this.dataBaseUrl}/api/odds/snapshot/${fixtureId}${query}`,
      z.array(oddsPayloadSchema),
    );
  }

  async getScoresSnapshot(
    fixtureId: number,
    asOfMs?: number,
  ): Promise<Result<readonly ScoresPayload[], TxlineError>> {
    const query = asOfMs === undefined ? '' : `?asOf=${asOfMs}`;
    return this.getJson(
      `${this.dataBaseUrl}/api/scores/snapshot/${fixtureId}${query}`,
      z.array(scoresPayloadSchema),
    );
  }

  async getScoresStatValidation(params: {
    readonly fixtureId: number;
    readonly seq: number;
    readonly statKey: number;
    readonly statKey2?: number;
  }): Promise<Result<ScoresStatValidation, TxlineError>> {
    const base = `${this.dataBaseUrl}/api/scores/stat-validation?fixtureId=${params.fixtureId}&seq=${params.seq}&statKey=${params.statKey}`;
    const url = params.statKey2 === undefined ? base : `${base}&statKey2=${params.statKey2}`;
    return this.getJson(url, scoresStatValidationSchema);
  }

  /** GET /api/odds/validation: the Merkle proof and snapshot for one odds update, keyed by its
   * messageId and ts, to prove the committed entry price on-chain via prove_entry_odds. */
  async getOddsValidation(params: {
    readonly messageId: string;
    readonly ts: number;
  }): Promise<Result<OddsValidation, TxlineError>> {
    const url = `${this.dataBaseUrl}/api/odds/validation?messageId=${encodeURIComponent(params.messageId)}&ts=${params.ts}`;
    return this.getJson(url, oddsValidationSchema);
  }

  private async getJson<TSchema extends z.ZodTypeAny>(
    url: string,
    schema: TSchema,
  ): Promise<Result<z.infer<TSchema>, TxlineError>> {
    const request: HttpRequest = { method: 'GET', url, headers: {}, timeoutMs: this.timeoutMs };
    const response = await this.sendWithRetry(request, true);
    if (!response.ok) {
      return response;
    }
    return parseJson(response.value.body, schema);
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.auth.jwt}`, 'X-Api-Token': this.auth.apiToken };
  }

  private async sendWithRetry(
    request: HttpRequest,
    authed: boolean,
  ): Promise<Result<HttpResponse, TxlineError>> {
    let attempt = 0;
    let reauthed = false;
    for (;;) {
      const effective: HttpRequest = authed
        ? { ...request, headers: { ...request.headers, ...this.authHeaders() } }
        : request;

      let response: HttpResponse;
      try {
        response = await this.http.send(effective);
      } catch (sendError) {
        // The HttpClient adapts a throwing transport boundary; this is the single
        // permitted catch. Network failures and timeouts become retryable values.
        if (attempt + 1 < this.backoff.maxAttempts) {
          await this.sleep(computeBackoffMs(attempt, this.backoff, this.prng));
          attempt += 1;
          continue;
        }
        return err({ kind: 'transport', status: null, detail: messageOf(sendError) });
      }

      if (response.status >= 200 && response.status < 300) {
        return ok(response);
      }

      // One JWT refresh on 401, then retry the original request without a backoff.
      if (response.status === 401 && authed && !reauthed) {
        const refreshed = await this.startGuestSession();
        if (!refreshed.ok) {
          return refreshed;
        }
        reauthed = true;
        continue;
      }

      // Transient server-side failures get the backoff treatment.
      if (
        (response.status === 429 || response.status >= 500) &&
        attempt + 1 < this.backoff.maxAttempts
      ) {
        await this.sleep(computeBackoffMs(attempt, this.backoff, this.prng));
        attempt += 1;
        continue;
      }

      return err(classifyStatus(response.status, response.body));
    }
  }
}
