import { bootstrapAgentRuntime } from '@txline-agent/agent';
import { startApiServer } from './server.js';

// Force a prompt exit if the feed has not unwound within this window after a stop signal.
const SHUTDOWN_GRACE_MS = 8000;
const delay = (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

/**
 * Process entrypoint for the headless agent: bootstrap the live runtime from the environment
 * (TxLINE token plus the devnet wallet), start the read-only API, then run the pipeline. A
 * judge runs this one process. On SIGINT/SIGTERM it stops the feed, drains the API, and prints
 * the run totals. sourceRef: docs/runbooks/M6-agent.md.
 */
const main = async (): Promise<void> => {
  const bootstrap = await bootstrapAgentRuntime(process.env);
  if (!bootstrap.ok) {
    console.error(`[main] cannot start agent: ${bootstrap.error}`);
    console.error(
      '[main] provide TXLINE_* plus SOLANA_RPC_URL/AGENT_KEYPAIR_PATH/TXORACLE_PROGRAM_ID; see docs/runbooks/M6-agent.md',
    );
    process.exit(1);
  }
  const { runtime, apiPort } = bootstrap.value;
  const server = await startApiServer({ store: runtime.store, port: apiPort });
  runtime.start();
  console.log(`[main] agent running; state at http://localhost:${server.port}/api/state`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[main] ${signal} received, shutting down`);
    await server.close();
    // Bound the stop: the feed unwinds on its next event or heartbeat, but if the upstream is
    // silent we still exit promptly rather than hang the container after SIGTERM.
    const summary = await Promise.race([
      runtime
        .stop()
        .then(
          (result) =>
            `committed ${result.committed}, settled ${result.settled}, events ${result.eventsProcessed}`,
        ),
      delay(SHUTDOWN_GRACE_MS).then(() => 'shutdown grace elapsed, forcing exit'),
    ]);
    console.log(`[main] stopped: ${summary}`);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
};

main().catch((error: unknown) => {
  console.error(`[main] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
