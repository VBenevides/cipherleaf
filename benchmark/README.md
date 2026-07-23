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

## Performance budgets

Measured on Linux/amd64 with a Ryzen 7 5800X3D. Regressions above these
user-visible limits should be investigated:

| workload | budget |
| --- | ---: |
| open and first search, 1,000 notes | 100 ms |
| indexed basic search, 1,000 notes | 50 ms |
| ordinary autosave | 50 ms |
| save a 1 MiB note | 750 ms |
| local sync after a 1 MiB change | 250 ms |
| editor transaction, 10,000 lines | 33 ms |
| link graph resolution, 10,000 notes | 16.7 ms |
| React note-list commit, 1,000 rows | 8 ms |
| React graph commit, 1,000 nodes/edges | 16.7 ms |

`bash benchmark/run.sh --output local` runs the complete suite. Bundle limits
are enforced by `frontend/tests/bundle.bench.mjs`.

## Profiles

The debug app exposes `net/http/pprof` when built with the `debug` tag and
`CIPHERLEAF_PPROF_ADDR=127.0.0.1:6060`. Capture CPU and heap profiles while
unlocking, searching, autosaving, and syncing:

```sh
go tool pprof -proto http://127.0.0.1:6060/debug/pprof/profile?seconds=30 > cpu.pprof
go tool pprof -proto http://127.0.0.1:6060/debug/pprof/heap > heap.pprof
go tool pprof -proto http://127.0.0.1:6060/debug/pprof/mutex > mutex.pprof
```

Benchmark profiles can also be captured with `-cpuprofile`, `-memprofile`, and
`-mutexprofile`. Keep profiles local because they can contain plaintext note
content.
