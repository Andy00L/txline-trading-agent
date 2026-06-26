#!/usr/bin/env bash
# Always-on standards gate. sourceRef: .claude/SKILL_GENERAL.md "Final check".
# Fatal checks run over code (packages, tools, scripts, programs). Docs get an
# informational pass; requirements.md is immutable and is excluded from fatal checks.
set -uo pipefail

code_dirs=""
for candidate in packages tools scripts programs; do
  [ -e "$candidate" ] && code_dirs="$code_dirs $candidate"
done
status=0

echo "[check-standards] long dashes (em U+2014 / en U+2013) in code"
if [ -n "$code_dirs" ] && grep -rnP "\xe2\x80\x94|\xe2\x80\x93" $code_dirs 2>/dev/null; then
  echo "  FAIL: replace long dashes with a hyphen, comma, period, or parentheses."
  status=1
else
  echo "  ok"
fi

echo "[check-standards] type suppressions in code"
if [ -n "$code_dirs" ] && grep -rnE "(:[[:space:]]*any\b|@ts-ignore|@ts-expect-error|@ts-nocheck|as unknown as)" $code_dirs --include='*.ts' --include='*.tsx' --include='*.rs' 2>/dev/null; then
  echo "  FAIL: remove the type suppression; fix the type instead."
  status=1
else
  echo "  ok"
fi

echo "[check-standards] browser storage (allowed only when persistence was requested)"
if [ -n "$code_dirs" ] && grep -rnE "localStorage|sessionStorage" $code_dirs --include='*.ts' --include='*.tsx' 2>/dev/null; then
  echo "  review the hits above"
else
  echo "  ok"
fi

echo "[check-standards] banned words (informational; 'leverage' is a verb-only ban)"
banned='unprecedented|remarkable|flagship|exceptional|cutting-edge|revolutionary|next-generation|paradigm shift|synergy|leverage|empower|streamline|seamless|holistic|best-in-class|world-class|robust ecosystem|turnkey'
word_targets="$code_dirs"
[ -e docs ] && word_targets="$word_targets docs"
if [ -n "$word_targets" ] && grep -rniE "$banned" $word_targets --include='*.ts' --include='*.tsx' --include='*.rs' --include='*.md' 2>/dev/null; then
  echo "  review the hits above by hand"
else
  echo "  ok"
fi

if [ "$status" -eq 0 ]; then
  echo "[check-standards] PASS"
else
  echo "[check-standards] FAIL"
fi
exit "$status"
