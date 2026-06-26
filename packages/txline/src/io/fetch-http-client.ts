import type { HttpClient, HttpRequest, HttpResponse } from '../http/types.js';

/**
 * Production HttpClient over the global fetch with an AbortController timeout. A
 * network failure or timeout rejects (the resilient client retries it); an HTTP
 * error status resolves with its status code. The body is read exactly once.
 */
export class FetchHttpClient implements HttpClient {
  async send(request: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, request.timeoutMs);
    try {
      const init: RequestInit = {
        method: request.method,
        headers: { ...request.headers },
        signal: controller.signal,
      };
      if (request.body !== undefined) {
        init.body = request.body;
      }
      const response = await fetch(request.url, init);
      const body = await response.text();
      return { status: response.status, body };
    } finally {
      clearTimeout(timer);
    }
  }
}
