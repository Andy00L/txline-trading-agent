#!/usr/bin/env bash
# core must be pure: no IO, clock, RNG, env, globals, chain client, or other
# workspace packages. sourceRef: docs/BUILD_PLAN.md ("core -> nothing").
set -uo pipefail
core="packages/core/src"
[ -d "$core" ] || { echo "[check-core-purity] no $core yet, skipping"; exit 0; }
status=0

echo "[check-core-purity] forbidden runtime calls (clock, RNG, env, globals, fetch)"
if grep -rnE "Date\.now\(|performance\.now\(|Math\.random\(|process\.(env|hrtime|argv)|globalThis\.|[^a-zA-Z]fetch\(" "$core" --include='*.ts' 2>/dev/null; then
  echo "  FAIL: core is deterministic and pure; inject a Clock and a seeded PRNG, do no IO."
  status=1
else
  echo "  ok"
fi

echo "[check-core-purity] forbidden imports (node, chain client, http)"
if grep -rnE "from '(node:|@solana/|@coral-xyz/|axios|node-fetch|undici)" "$core" --include='*.ts' 2>/dev/null; then
  echo "  FAIL: no IO or chain client in core."
  status=1
else
  echo "  ok"
fi

echo "[check-core-purity] forbidden package imports (core depends on nothing)"
if grep -rnE "from '@txline-agent/(txline|onchain-client|agent|backtest|api|dashboard)'" "$core" --include='*.ts' 2>/dev/null; then
  echo "  FAIL: core depends on nothing."
  status=1
else
  echo "  ok"
fi

if [ "$status" -eq 0 ]; then
  echo "[check-core-purity] PASS"
else
  echo "[check-core-purity] FAIL"
fi
exit "$status"
