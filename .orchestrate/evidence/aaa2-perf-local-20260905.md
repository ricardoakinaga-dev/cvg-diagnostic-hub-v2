# AAA2-042/043 local performance evidence — 2026-09-05

**Result:** `CONDITIONAL` local proof. The deterministic harness itself passed its local gates; this packet does not approve NFR-PERF-001/002 for a hospital or pilot workload.

## Environment

- Repository: `/home/ricardo/cvg-diagnostic-hub-v2`
- Observed HEAD: `01bb1804682b4bb503e00e41c1361dc704d2294d`
- Runtime observed: Node `v24.20.0`, npm `11.19.0`; repository/CI target remains Node 22.
- Dataset: version `aaa2-synthetic-v1`, seed `12648430`, 2,400 records, 10,755 history events, 8 departments with deterministic skew (`LAB=1,320`, `RX=408`, `US=288`, remaining sectors 72–84), maximum queue depth 660, scoped departments `LAB/RX/US`, homonym `Thor Almeida`, rare protocol `CVG-2026-RARE-0001`, digest `4e28b71d`.
- Measurement: deterministic virtual clock. The harness executes deterministic query semantics over the synthetic fixture and derives a stable latency model from operation, scan cardinality and request seed.

## Commands

```text
npm run perf:synthetic
PASS — local gates: read p95 <= 500 ms, exact search p95 <= 300 ms, textual search p95 <= 800 ms, unexpected errors = 0

npm run test:perf
PASS — 7 tests
```

## Results

| Workload | Requests | Concurrency | Errors | Expected errors | Unexpected errors | p50 | p95 | p99 | Virtual duration | Throughput |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Operational queue read | 120 | 12 | 0 | 0 | 0 | 86 ms | 104 ms | 113 ms | 1,075 ms | 111.63 req/s |
| Exact protocol search | 120 | 12 | 0 | 0 | 0 | 54 ms | 60 ms | 61 ms | 565 ms | 212.39 req/s |
| Textual homonym search | 120 | 12 | 0 | 0 | 0 | 162 ms | 171 ms | 171 ms | 1,647 ms | 72.86 req/s |
| Invalid search validation | 12 | 4 | 12 | 12 | 0 | 5 ms | 5 ms | 5 ms | 15 ms | 800 req/s |

Aggregate: 372 requests, 12 expected validation errors, 0 unexpected errors, aggregate error rate 3.23%, maximum concurrency 12, virtual duration 3,302 ms and virtual throughput 112.66 req/s. Workload windows are summed because the CLI measures each workload independently. Expected validation errors are reported separately so the local gate does not hide error accounting.

## Reproducibility and scope

The focused tests prove same-seed dataset digest and records, history volume, homonym and rare-protocol fixtures, scope-before-result behavior, expected-error classification, deterministic p50/p95/p99, and the effect of changing concurrency on virtual completion time. The harness covers queue reads plus exact and textual search with pagination-shaped result limits and a deterministic skewed multi-sector distribution.

This is not representative-load acceptance. The virtual clock does not measure wall-clock server latency, CPU, memory, network, PostgreSQL locks, query plans or `EXPLAIN`; no durable PostgreSQL, two-instance fanout, SSE, clinical command, resource saturation, nominal/pico/soak run or approved SLO was exercised. AAA2-042 still needs real relational `EXPLAIN` and an operation-reviewed manifest. AAA2-043 still needs two instances, durable storage, resource/queue observations and the approved pilot workload. D-05 and the external acceptance of NFR-PERF-001/002 remain open.
