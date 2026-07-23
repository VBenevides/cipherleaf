# Benchmark runs

Run both benchmark suites and store their raw output:

```bash
bash benchmark/run.sh --output local
bash benchmark/run.sh --output cloud --intermediate keep
```

`local` writes ignored results to `local/benchmark/results/`; `cloud` writes
shareable results to `benchmark/results/`. Summaries use
`summary-{DATETIME_UTC}.md`.

Each timed workload runs 10 times; bundle sizes are measured once. Raw `go-`,
`frontend-`, and `bundle-` results are deleted after the summary succeeds
unless `--intermediate keep` is provided. The summary reports latency
distribution, scaling, memory/GC/disk counters, frame misses, parse counts,
DOM-node proxies, dashboard cache reads, and raw/gzip bundle sizes.

React measurements use server rendering and frame misses use the 16.67 ms
budget. Browser commit timing and network transport timing still require their
respective browser and remote-provider profilers. SSH cold/reuse benchmarks run
when `CIPHERLEAF_BENCH_REPOSITORY` and `CIPHERLEAF_BENCH_SSH_KEY` are set.

Compare two runs with `diff -u old.md new.md`.
