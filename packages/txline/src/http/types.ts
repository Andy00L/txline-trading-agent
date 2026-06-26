export type HttpMethod = 'GET' | 'POST';

export type HttpRequest = {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
};

export type HttpResponse = {
  readonly status: number;
  readonly body: string;
};

/**
 * Transport abstraction so the client is testable and the resilience logic stays
 * separate from IO. Production wraps the global fetch with an AbortController
 * timeout; tests pass a recording mock. A transport-level failure (network down,
 * timeout) rejects the promise; an HTTP error status resolves normally with its
 * status code so the client can classify it.
 */
export interface HttpClient {
  send(request: HttpRequest): Promise<HttpResponse>;
}

export type TxlineErrorKind =
  | 'unauthorized' // 401, JWT missing or expired
  | 'forbidden' // 403, API token invalid or insufficient
  | 'not-found' // 404
  | 'rate-limited' // 429
  | 'server-error' // 5xx
  | 'transport' // network failure or timeout (send rejected)
  | 'bad-status' // any other unexpected status
  | 'parse'; // body was not valid JSON or failed schema validation

/** A request failure as a value. status is null for transport and parse failures.
 * detail never includes the auth headers (they are sent in headers, not the URL,
 * and response bodies are truncated). */
export type TxlineError = {
  readonly kind: TxlineErrorKind;
  readonly status: number | null;
  readonly detail: string;
};
