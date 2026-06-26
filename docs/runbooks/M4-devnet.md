# M4 devnet runbook: commit and CPI-settle against the live txoracle

This runbook finishes M4 on devnet. It deploys the `agent_ledger` program, then runs one
end to end proof: commit a sealed decision before reveal, settle it by CPI into the live
`txoracle::validate_stat`, and confirm a tampered proof is rejected. The runnable script is
[tools/devnet/src/settle-e2e.ts](../../tools/devnet/src/settle-e2e.ts); it drives the exact
production path (`TxlineClient` to `buildSettleArgs` to `SolanaOnChainPort`).

## What this proves

1. A decision is committed on chain as `keccak256(borsh(RevealArgs))` before any outcome is
   revealed. The committed account holds only routing fields in the clear.
2. Settlement reveals the args and CPIs into `validate_stat`. The predicate is derived on
   chain from the claimed 1X2 result over (home goals minus away goals), so PnL is only
   written when the oracle attested score satisfies the claim.
3. A settle carrying a tampered Merkle proof reverts, leaving the decision open.

## Who runs what

The agent never runs git, deploys, or signs wallet transactions. You run the steps that are
externally visible or spend devnet SOL: the program deploy, the subscription token flow, and
(unless you explicitly authorize the agent) the e2e run. The agent runs the local build and
the verification gate, and prints these commands for you.

## Prerequisites (you provide)

| Item | How to get it | Where it goes |
| --- | --- | --- |
| Funded devnet wallet keypair | `solana-keygen new -o ~/.config/solana/agent.json`, then `solana airdrop 3 --url devnet` | `AGENT_KEYPAIR_PATH` in `.env` |
| TxLINE JWT + API token | guest auth then the free World Cup subscribe + activate (below) | `TXLINE_JWT`, `TXLINE_API_TOKEN` in `.env` |
| A finished World Cup fixture id + a scores event seq | pick a fixture whose final score root is posted; read its event `seq` from `/api/scores/historical/{fixtureId}` | `E2E_FIXTURE_ID`, `E2E_SEQ` in `.env` |

Devnet and paper trading only. No real funds move; the bankroll is paper micro-USDC.

## Step 1: configure `.env`

Copy `.env.example` to `.env` and fill the blanks (`AGENT_KEYPAIR_PATH`, `TXLINE_JWT`,
`TXLINE_API_TOKEN`, `E2E_FIXTURE_ID`, `E2E_SEQ`). `.env` is gitignored. Never paste tokens or
keypairs into chat or commit them.

## Step 2: build and deploy the program (you run)

```bash
# Build the deployable .so. Use cargo build-sbf, not anchor build: the Agave 3.x platform
# tools break anchor's IDL post-step on this machine (see the recon notes).
cd programs/agent_ledger
cargo build-sbf

# The declared program id must equal the deploy address, or Anchor rejects every call with
# DeclaredProgramIdMismatch. Confirm the build keypair matches declare_id! (FLZi...).
solana address -k ../../target/deploy/agent_ledger-keypair.json
# Expected: FLZiKMUaPAGMtPLbfHvHwfiVfkTZD8RZ84CSrkDy1kLD

# If it differs (the original keypair was not preserved), pick ONE:
#   a) restore the original target/deploy/agent_ledger-keypair.json, or
#   b) adopt the new id: put it in declare_id! (programs/agent_ledger/src/lib.rs) and
#      Anchor.toml, set AGENT_PROGRAM_ID in .env to it, then re-run cargo build-sbf.

# Deploy to devnet (you run; this is externally visible and spends devnet SOL).
solana config set --url devnet --keypair "$AGENT_KEYPAIR_PATH"
solana program deploy ../../target/deploy/agent_ledger.so \
  --program-id ../../target/deploy/agent_ledger-keypair.json
```

## Step 3: get a TxLINE token (you run)

The free World Cup tier charges 0 TxLINE but still needs an on-chain `subscribe` transaction
signed by your wallet, then an off-chain activation. The reference flow is in the recon
corpus at `~/.txline-recon/txoracle/data_validation/validate_scores_onchain.ts` (guest auth,
`subscribe(serviceLevel, weeks)`, then `POST /api/token/activate`). Run it against
`oracle-dev.txodds.com`, then copy the returned JWT and API token into `.env`.

## Step 4: build the workspace and run the e2e

```bash
# From the repo root. The agent can run these; authorize it for settle:e2e since that sends
# devnet transactions, or run it yourself.
pnpm -r build
cd tools/devnet && pnpm settle:e2e
# equivalently from root: node --env-file=.env tools/devnet/dist/settle-e2e.js
```

With no devnet wallet or token configured the script prints a skip line and exits 0, so it is
safe to invoke early.

## Expected output

```
[settle-e2e] initialized strategy: https://explorer.solana.com/tx/...
[settle-e2e] proven score home H away A; claimed result R
[settle-e2e] committed decision index 0: https://explorer.solana.com/tx/...
[settle-e2e] settled decision A won=true pnl=...: https://explorer.solana.com/tx/...
[settle-e2e] committed decision index 1: https://explorer.solana.com/tx/...
[settle-e2e] tampered proof correctly rejected (settle reverted): ...
[settle-e2e] settled decision B won=true pnl=...: https://explorer.solana.com/tx/...
[settle-e2e] strategy bankroll ... realizedPnl ... wins 2 losses 0
[settle-e2e] M4 devnet proof complete: ...
```

Open the explorer links (devnet) to see `DecisionCommitted` before kickoff and
`DecisionSettled` after, with the settle transaction's inner CPI to the txoracle program.

## One open item the live run confirms (O4)

The proof `hash` and root fields are decoded as hex by `decodeHash32`
([packages/onchain-client/src/settle-args.ts](../../packages/onchain-client/src/settle-args.ts)),
matching the assumption pinned in `packages/txline/src/schemas/proof.ts`. If the first real
stat-validation response makes `buildSettleArgs` return a `bad-hash` error, the wire encoding
is not hex (it is base64 or a byte array). That decoder is the single place to change; nothing
else moves.

## Troubleshooting

- `not-initialized` on commit: the strategy account does not exist yet. The script creates it
  on first run; if you changed `STRATEGY_ID`, it starts a fresh ledger.
- `index-mismatch` on commit: a stale reveal index. The script reads `decisions_count` each
  time, so this only happens if another process committed concurrently. Re-run.
- settle reverts on a valid proof: usually the daily scores root for that `ts` is not posted
  yet (roots publish every 5 minutes), or the chosen `seq` is an in-running snapshot rather
  than the final score. Pick a `seq` after the match finished.
- `rpc` errors: devnet rate limits the public RPC. Set `SOLANA_RPC_URL` to a devnet endpoint
  with more headroom and retry.
