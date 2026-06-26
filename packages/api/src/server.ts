import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AgentSnapshot, AgentStateStore } from '@txline-agent/agent';

/**
 * Read-only HTTP and SSE projection of the agent's state. Three routes:
 *   GET /health      -> { status: "ok" } liveness for Docker and the dashboard.
 *   GET /api/state   -> the current AgentSnapshot as JSON.
 *   GET /api/events  -> Server-Sent Events; the current snapshot, then one on each change.
 * It is strictly read-only (no route mutates the agent), built on node:http to avoid adding
 * a web framework. CORS is open so the static dashboard (M7) can read it from any origin.
 * The snapshot already encodes bigints as strings, so plain JSON.stringify is safe.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
} as const;

// SSE keep-alive comment cadence, under the common 60s proxy idle timeout.
const SSE_PING_MS = 25_000;

export type ApiServer = {
  readonly port: number;
  close(): Promise<void>;
};

export type StartApiServerDeps = {
  readonly store: AgentStateStore;
  readonly port: number;
  readonly log?: (message: string) => void;
};

const writeJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  response.end(JSON.stringify(body));
};

const handleEvents = (
  store: AgentStateStore,
  request: IncomingMessage,
  response: ServerResponse,
): void => {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...CORS_HEADERS,
  });
  const send = (snapshot: AgentSnapshot): void => {
    response.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  };
  send(store.snapshot());
  const unsubscribe = store.subscribe(send);
  const ping = setInterval(() => {
    response.write(': ping\n\n');
  }, SSE_PING_MS);
  ping.unref(); // the keep-alive timer must not hold the process open on its own
  request.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
};

const handleRequest = (
  store: AgentStateStore,
  request: IncomingMessage,
  response: ServerResponse,
): void => {
  const method = request.method ?? 'GET';
  if (method === 'OPTIONS') {
    response.writeHead(204, CORS_HEADERS);
    response.end();
    return;
  }
  if (method !== 'GET') {
    writeJson(response, 405, { error: 'method not allowed' });
    return;
  }
  const path = (request.url ?? '/').split('?')[0] ?? '/';
  if (path === '/health') {
    writeJson(response, 200, { status: 'ok' });
    return;
  }
  if (path === '/api/state') {
    writeJson(response, 200, store.snapshot());
    return;
  }
  if (path === '/api/events') {
    handleEvents(store, request, response);
    return;
  }
  writeJson(response, 404, { error: 'not found' });
};

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
    // Force any open SSE connections closed so close() resolves promptly on shutdown.
    server.closeAllConnections();
  });

/** Start the read-only API server. Resolves once it is listening; port 0 binds an ephemeral
 * port (read it back from the returned ApiServer.port). */
export const startApiServer = (deps: StartApiServerDeps): Promise<ApiServer> => {
  const log = deps.log ?? ((message: string) => console.log(message));
  const server = createServer((request, response) => {
    handleRequest(deps.store, request, response);
  });
  return new Promise((resolve) => {
    server.listen(deps.port, () => {
      const address = server.address();
      const boundPort = typeof address === 'object' && address !== null ? address.port : deps.port;
      log(`[startApiServer] listening on http://localhost:${boundPort}`);
      resolve({ port: boundPort, close: () => closeServer(server) });
    });
  });
};
