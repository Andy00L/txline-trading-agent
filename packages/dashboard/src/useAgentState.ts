import { useEffect, useState } from 'react';
import { subscribeToEvents, type AgentSnapshot } from './api';

export type AgentState = {
  readonly snapshot: AgentSnapshot | null;
  /** Whether the dashboard's SSE transport to the API is currently open. Distinct from the
   * server-reported feed status: this is the dashboard-to-API link, used so a dropped
   * connection is shown as reconnecting rather than freezing on the last snapshot. */
  readonly connected: boolean;
};

/** Subscribe to the agent's live state for the lifetime of the component. snapshot is null until
 * the first snapshot arrives; connected tracks the SSE transport. */
export const useAgentState = (): AgentState => {
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    // external system: the agent's SSE endpoint. It pushes the current snapshot on connect and
    // one on every change; onopen/onerror track the transport so the UI never shows stale data
    // as live. The subscription is closed on unmount.
    const unsubscribe = subscribeToEvents(setSnapshot, setConnected);
    return unsubscribe;
  }, []);
  return { snapshot, connected };
};
