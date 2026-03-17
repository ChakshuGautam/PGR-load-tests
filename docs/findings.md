# Findings

Performance results from load testing DIGIT PGR with up to 1M records (March 2026).

## Executive Summary

| Metric | Value |
|--------|-------|
| Peak throughput (empty DB) | 37 lifecycles/sec |
| Throughput at 1M records | 6.3 lifecycles/sec |
| Daily capacity at 1M | **544,320 transactions/day** |
| VU ceiling (dev, 8 vCPU) | ~250 concurrent users |
| VU ceiling (prod, 16 vCPU) | ~300 concurrent users |
| Database bugs found | **3 critical** |
| Throughput recovery after fixes | **9.4x** |
| Total records seeded | 1,006,743 complaints |

The system comfortably exceeds a 10,000 txn/day target even at 1M records. Three database performance bugs were discovered that caused 5.2x throughput degradation as records grew. After fixing all three, throughput recovered to 37/s at 100K records. At 1M records, remaining degradation is caused by a fundamental query pattern in the workflow service that requires an upstream code change.

## Baseline Performance

### Ramp Tests (No CPU Limits, Empty Database)

| Test | Machine | Transactions | Success | p95 Latency |
|------|---------|-------------|---------|-------------|
| ramp-2vu | Dev (8 vCPU) | 79 | 100% | 372ms |
| ramp-2vu | Prod (16 vCPU) | 84 | 100% | 361ms |
| ramp-10vu | Dev (8 vCPU) | 436 | 100% | 338ms |
| ramp-10vu | Prod (16 vCPU) | 437 | 100% | 333ms |

At low record counts, dev and prod perform nearly identically — the workload is not CPU-bound.

### Burst Tests (VU Ceiling)

| VUs | Dev (8 vCPU) | Prod (16 vCPU) |
|-----|------------|---------------|
| 20 | 100% pass | 100% pass |
| 80 | 100% pass | 100% pass |
| 150 | 100% pass | 100% pass |
| 250 | 100% pass, p95=476ms | 100% pass |
| 300 | failures | 100% pass, p95=629ms |
| 350 | - | 100% pass |
| 400 | - | failures start |

**VU ceilings:** Dev ~250, Prod ~300. Failures at the ceiling are caused by connection exhaustion and PgBouncer timeouts, not CPU.

## Database Performance Bugs

Three root causes were identified by enabling Postgres slow query logging (`log_min_duration_statement = 100ms`) and analyzing query plans with `EXPLAIN (ANALYZE, BUFFERS)`.

### Bug 1: Missing Foreign Key Index on `eg_pgr_address_v2.parentid`

The address table has a foreign key to `eg_pgr_service_v2(id)` but no index on the FK column. Every complaint fetch joins through this FK, triggering a sequential scan of the entire address table.

**Before (100K records):**
```
Seq Scan on eg_pgr_address_v2  (cost=0..2891 rows=1 width=648)
  Filter: (parentid = $1)
  Rows Removed by Filter: 102,437
  Execution Time: 24.1ms
```

**After:**
```
Index Scan using idx_eg_pgr_address_v2_parentid  (cost=0..8 rows=1 width=648)
  Index Cond: (parentid = $1)
  Execution Time: 0.12ms
```

**Fix:**
```sql
CREATE INDEX idx_eg_pgr_address_v2_parentid ON eg_pgr_address_v2 (parentid);
```

**Impact: 200x improvement** on address lookups.

### Bug 2: Workflow `LIKE ANY` Instead of `= ANY`

The workflow service searches for process instances using `LIKE ANY(ARRAY['%businessId%', ...])`. Since businessIds are exact values (e.g., `PB-PGR-2026-03-16-105868`), the `%wildcards%` are unnecessary. But `LIKE` with leading wildcards defeats btree index usage, forcing a sequential scan of the entire workflow table.

This query runs 3-4 times per complaint lifecycle (it's the workflow status lookup), making it the dominant cost at scale.

**The query:**
```sql
SELECT id FROM eg_wf_processinstance_v2 pi_outer
WHERE pi_outer.lastmodifiedTime = (
    SELECT max(lastmodifiedTime) FROM eg_wf_processinstance_v2 pi_inner
    WHERE pi_inner.businessid = pi_outer.businessid AND tenantid = $1
)
AND pi_outer.tenantid = $1
AND pi_outer.businessId LIKE ANY(ARRAY['%PB-PGR-2026-03-16-105868%'])
```

**Performance comparison (300K workflow rows):**

| Approach | Time | Index Used |
|----------|------|-----------|
| `LIKE ANY` (current, no index) | 100ms | Seq scan |
| `LIKE ANY` + GIN trigram | 3.1ms | GIN index |
| `= ANY` + btree (ideal fix) | 0.13ms | Btree index |

**Workaround applied:**
```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_wf_pi_bizid_trgm
  ON eg_wf_processinstance_v2 USING gin (businessid gin_trgm_ops);
```

**Impact: 32x improvement** with GIN workaround. An upstream code fix (`=` instead of `LIKE`) would yield **769x improvement**.

### Bug 3: JIT Compilation Overhead on OLTP Queries

Postgres JIT compilation is designed for complex analytical queries. On the simple OLTP queries in DIGIT, JIT spends more time compiling than the query takes to execute.

**Example:** A query that executes in 90ms spends an additional 324ms on JIT compilation.

**Fix:**
```sql
ALTER SYSTEM SET jit = off;
SELECT pg_reload_conf();
```

**Impact: 4.3x improvement** on affected queries.

## Combined Fix Impact

All three fixes applied together at 100K records:

| Metric | Before Fixes | After All Fixes | Speedup |
|--------|-------------|-----------------|---------|
| Throughput (50 VUs) | 3.96/s | 37.09/s | **9.4x** |
| HTTP avg latency | 4,090ms | 433ms | **9.4x** |
| HTTP p95 latency | 5,620ms | 558ms | **10.1x** |

## 1M Record Seeding

### Methodology

- Scenario: `seed-1m.js` — 50 VUs, 540,000 shared iterations, CREATE → ASSIGN → RESOLVE
- 1-second delay between CREATE and ASSIGN for Kafka persister async write
- All 33 complaint types rotated, 500 citizen users
- Target: prod machine (16 vCPU, 32 GB RAM)

### Results

| Metric | Value |
|--------|-------|
| Iterations completed | 540,000 / 540,000 (100%) |
| Success rate | 99.99% (539,969 successes) |
| HTTP failures | 31 / 1,620,050 (0.002%) |
| Avg throughput | 11.8 completions/sec |
| Duration | 12 hours 43 minutes |
| Data transferred | 8.4 GB received, 7.1 GB sent |

### Final Database State

| Table | Records | Size |
|-------|---------|------|
| `eg_pgr_service_v2` | 1,006,743 | 742 MB |
| `eg_wf_processinstance_v2` | 2,892,719 | 2,301 MB |
| `eg_pgr_address_v2` | ~1,006,743 | ~390 MB |
| **Total database** | - | **3,532 MB** |

## Performance at 1M Records

With all database fixes applied, 50 VUs:

| Metric | Value |
|--------|-------|
| Throughput | 6.3 lifecycles/sec |
| HTTP avg latency | 2,160ms |
| HTTP p95 latency | 3,340ms |
| Success rate | 100% |
| **Daily capacity** | **544,320 txn/day** |

## Degradation Curve

Throughput as a function of record count (all DB fixes applied, 50 VUs):

| Records | HTTP Avg Latency | Throughput |
|---------|-----------------|------------|
| ~0 (empty) | 450ms | 37/s |
| 100K | 433ms | 37/s |
| ~300K | ~700ms | ~22/s |
| ~500K | ~1,000ms | ~14/s |
| ~700K | ~1,400ms | ~12/s |
| **1,006K** | **2,160ms** | **6.3/s** |

The degradation is driven by the workflow `LIKE ANY` correlated subquery. Even with the GIN trigram index, the query cost grows with table size. An upstream fix to use `= ANY` would flatten this curve significantly.

## Recommended SQL Indexes

Apply these to any DIGIT Postgres instance running at scale:

```sql
-- 1. Missing FK index on address table (200x improvement)
CREATE INDEX idx_eg_pgr_address_v2_parentid
  ON eg_pgr_address_v2 (parentid);

-- 2. Composite index for workflow tenant+businessservice queries
CREATE INDEX idx_eg_wf_pi_v2_tenant_bsvc
  ON eg_wf_processinstance_v2 (tenantid, businessservice, lastmodifiedtime DESC);

-- 3. Composite index for workflow tenant+businessid lookups
CREATE INDEX idx_wf_pi_tenant_bizid_time
  ON eg_wf_processinstance_v2 (tenantid, businessid, lastmodifiedtime DESC);

-- 4. GIN trigram index for LIKE ANY workaround (32x improvement)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_wf_pi_bizid_trgm
  ON eg_wf_processinstance_v2 USING gin (businessid gin_trgm_ops);

-- 5. Disable JIT for OLTP workloads (4.3x improvement)
ALTER SYSTEM SET jit = off;
SELECT pg_reload_conf();

-- 6. Enable slow query logging (for ongoing monitoring)
ALTER SYSTEM SET log_min_duration_statement = 100;
SELECT pg_reload_conf();
```

## Recommended Upstream Fix

The single most impactful change for DIGIT performance at scale:

**File:** `egov-workflow-v2` → `WorkflowRepository.java`

**Change:** Replace `LIKE ANY(ARRAY[...])` with `= ANY(ARRAY[...])` in process instance search queries, and remove the `%...%` wrapping of businessId values.

**Impact at 300K workflow rows:**

| Current | Fixed | Improvement |
|---------|-------|-------------|
| 100ms (seq scan) | 0.13ms (btree) | **769x** |
| 3.1ms (GIN workaround) | 0.13ms (btree) | **24x** |

BusinessIds are exact values (`PB-PGR-2026-03-16-105868`), not patterns. The wildcards serve no purpose.

## Operational Lessons

1. **Docker log rotation** — Container logs can fill disk in hours under load. Configure `/etc/docker/daemon.json`:
   ```json
   {
     "log-driver": "json-file",
     "log-opts": { "max-size": "100m", "max-file": "3" }
   }
   ```

2. **Docker volume pruning** — Orphaned volumes accumulate. Run `docker volume prune` periodically. One cleanup freed 36.4 GB.

3. **Kong DNS cache** — After `docker compose restart`, Kong caches stale container IPs. Use `docker compose down && up` instead to recreate the network.

4. **Kafka async delay** — The Persister writes to Postgres asynchronously via Kafka. Under high load, there's a 1+ second delay between an API response and the data being queryable. Seed scripts must account for this with a sleep between CREATE and ASSIGN.

5. **Encryption service resilience** — `egov-enc-service` may fail after a disk-full event. A full service restart (`docker compose restart egov-enc-service`) recovers it.
