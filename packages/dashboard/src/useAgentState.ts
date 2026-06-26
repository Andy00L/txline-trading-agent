import { useEffect, useState } from 'react';
import { subscribeToEvents, type AgentSnapshot } from './api';

/** Subscribe to the agent's live state for the lifetime of the component. Returns null until
 * the first snapshot arrives. */
export const useAgentState = (): AgentSnapshot | null => {
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
  useEffect(() => {
    // external system: the agent's SSE endpoint. It pushes the current snapshot on connect
    // and one on every change; the subscription is closed on unmount.
    const unsubscribe = subscribeToEvents(setSnapshot);
    return unsubscribe;
  }, []);
  return snapshot;
};
