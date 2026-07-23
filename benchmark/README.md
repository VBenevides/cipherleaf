# Benchmark runs

Run both benchmark suites and store their raw output:

```bash
bash benchmark/run.sh --output local
bash benchmark/run.sh --output cloud
```

`local` writes ignored results to `local/benchmark/results/`; `cloud` writes
shareable results to `benchmark/results/`. Files use
`{TYPE}-{DATETIME_UTC}.txt`.

Compare two runs with `diff -u old.txt new.txt`.
