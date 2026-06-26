import { afterEach, describe, expect, it } from 'vitest';
import type { Clock } from '@txline-agent/core';
import { AgentStateStore } from '@txline-agent/agent';
import { startApiServer, type ApiServer } from './server.js';

class FixedClock implements Clock {
  nowMs(): number {
    return 1_000;
  }
}

describe('startApiServer', () => {
  let server: ApiServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it('serves health and the state snapshot as JSON with open CORS', async () => {
    const store = new AgentStateStore({ clock: new FixedClock(), startingBankroll: 1_000_000_000n });
    server = await startApiServer({ store, port: 0, log: () => {} });

    const health = await fetch(`http://localhost:${server.port}/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get('content-type')).toContain('application/json');
    expect(await health.text()).toContain('"status":"ok"');

    const state = await fetch(`http://localhost:${server.port}/api/state`);
    expect(state.status).toBe(200);
    expect(state.headers.get('access-control-allow-origin')).toBe('*');
    const body = await state.text();
    expect(body).toContain('"startingBankrollMicroUsd":"1000000000"');
    expect(body).toContain('"positions":[]');
  });

  it('reflects a recorded commit in the snapshot', async () => {
    const store = new AgentStateStore({ clock: new FixedClock(), startingBankroll: 0n });
    store.recordCommit({
      index: 0,
      onChainIndex: '7',
      fixtureId: 17588302,
      marketKey: '17588302:1X2:FT:',
      outcome: 'home',
      signalKind: 'steam',
      stakeMicroUsd: '25000000',
      entryOddsMilli: 2100,
      fairProb: 0.5,
      committedAtMs: 1_000,
      txSig: 'commit-sig',
      explorerUrl: 'https://explorer.solana.com/tx/commit-sig?cluster=devnet',
    });
    server = await startApiServer({ store, port: 0, log: () => {} });

    const state = await fetch(`http://localhost:${server.port}/api/state`);
    const body = await state.text();
    expect(body).toContain('"commitsCount":1');
    expect(body).toContain('"txSig":"commit-sig"');
  });

  it('returns 404 for an unknown path', async () => {
    const store = new AgentStateStore({ clock: new FixedClock(), startingBankroll: 0n });
    server = await startApiServer({ store, port: 0, log: () => {} });
    const response = await fetch(`http://localhost:${server.port}/nope`);
    expect(response.status).toBe(404);
  });
});
