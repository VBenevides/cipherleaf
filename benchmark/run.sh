#!/usr/bin/env bash
set -euo pipefail

output="${2:-local}"
if [[ "${1:-}" != "--output" || $# -ne 2 ]]; then
  echo "usage: bash benchmark/run.sh --output [local|cloud]" >&2
  exit 2
fi

case "$output" in
  local) destination="local/benchmark/results" ;;
  cloud) destination="benchmark/results" ;;
  *) echo "output must be local or cloud" >&2; exit 2 ;;
esac

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$destination"

go test ./internal/vault -run '^$' \
  -bench '^BenchmarkRepresentativeVaultWorkloads$' -benchmem -count=5 \
  | tee "$destination/go-$timestamp.txt"

(cd frontend && npm run bench) \
  | tee "$destination/frontend-$timestamp.txt"
