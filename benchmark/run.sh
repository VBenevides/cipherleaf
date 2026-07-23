#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: bash benchmark/run.sh --output [local|cloud] [--intermediate keep|delete]" >&2
  exit 2
}

output=""
intermediate="delete"
while (( $# )); do
  case "$1" in
    --output) (( $# >= 2 )) || usage; output="$2"; shift 2 ;;
    --intermediate) (( $# >= 2 )) || usage; intermediate="$2"; shift 2 ;;
    *) usage ;;
  esac
done

case "$output" in
  local) destination="local/benchmark/results" ;;
  cloud) destination="benchmark/results" ;;
  *) echo "output must be local or cloud" >&2; exit 2 ;;
esac
case "$intermediate" in
  keep|delete) ;;
  *) echo "intermediate must be keep or delete" >&2; exit 2 ;;
esac

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$destination"
go_result="$destination/go-$timestamp.txt"
frontend_result="$destination/frontend-$timestamp.txt"
bundle_result="$destination/bundle-$timestamp.txt"
summary="$destination/summary-$timestamp.md"

{
  go test ./internal/vault -run '^$' \
    -bench '^(BenchmarkRepresentativeVaultWorkloads|BenchmarkOptimizationScaling|BenchmarkSearchCases|BenchmarkSaveListWorkflow|BenchmarkOpenPhases|BenchmarkTimeDashboardCache|BenchmarkSyncLocalWorkloads)$' \
    -benchmem -count=10
  go test ./internal/githubsync -run '^$' \
    -bench '^BenchmarkGitHubSSHConnection$' -benchmem -count=10
} \
  | tee "$go_result"

(cd frontend && npm run bench) \
  | tee "$frontend_result"

(cd frontend && npm run build >/dev/null && node tests/bundle.bench.mjs) \
  | tee "$bundle_result"

node benchmark/summary.mjs \
  "$go_result" \
  "$frontend_result" \
  "$bundle_result" \
  | tee "$summary"

if [[ "$intermediate" == "delete" ]]; then
  rm -f "$go_result" "$frontend_result" "$bundle_result"
fi
