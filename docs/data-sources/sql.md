---
title: SQL Source
---

# SQL Source

The `sql` source lets Recotem train recommenders directly from a relational database via [SQLAlchemy 2](https://www.sqlalchemy.org/). Supported dialects are PostgreSQL, MySQL/MariaDB, and SQLite. Other dialects are not supported and will raise `DataSourceError` at training time.

See `examples/sql-sqlite/` in the recotem repository for a zero-cloud walkthrough.

## Install

```bash
pip install "recotem[postgres]"   # PostgreSQL (via psycopg)
pip install "recotem[mysql]"      # MySQL / MariaDB (via PyMySQL)
pip install "recotem[sqlite]"     # SQLite (stdlib — no extra driver needed)
```

Without any of these extras, `recotem train` exits with:

```
DataSourceError: sqlalchemy is required for SQLSource. Install one of: recotem[postgres], recotem[mysql], recotem[sqlite].
```

## DSN injection (env var)

The DSN is never written to the recipe. The recipe only names an environment variable; Recotem reads the DSN from that variable at training time.

```bash
export RECOTEM_RECIPE_DB_DSN="postgresql+psycopg://user:pass@host:5432/db?sslmode=require"
uv run recotem train recipes/my_recipe.yaml
```

The variable name must match `^RECOTEM_RECIPE_[A-Z0-9_]+$`. Any other prefix is rejected at recipe load (`RecipeError`, exit 2).

## Recipe configuration

```yaml
source:
  type: sql
  dsn_env: RECOTEM_RECIPE_DB_DSN
  query: |
    SELECT user_id, product_id, purchased_at
    FROM orders
    WHERE purchased_at >= :since
      AND status = 'paid'
  query_parameters:
    since: ${RECOTEM_RECIPE_SINCE}
  connect_timeout_seconds: 10
  statement_timeout_seconds: 300
```

| Field | Required | Default | Notes |
|---|---|---|---|
| `dsn_env` | yes | — | Name of an env var matching `^RECOTEM_RECIPE_[A-Z0-9_]+$` containing the DSN. The DSN itself is never written to the recipe. |
| `query` | yes | — | Raw SQL. Never subject to `${...}` expansion (SQL injection foreclosure). |
| `query_parameters` | no | `{}` | Bound via SQLAlchemy `text().bindparams(...)`. Subject to `${RECOTEM_RECIPE_*}` expansion. |
| `connect_timeout_seconds` | no | `10` | Valid range `[1, 60]`. Out-of-range raises `ValidationError`. Passed as `connect_timeout` (PG/MySQL) or `timeout` (SQLite). |
| `statement_timeout_seconds` | no | `300` | Valid range `[1, 1800]`. See [Statement timeouts](#statement-timeouts) for per-dialect details. |

## DSN examples

| Dialect | DSN |
|---|---|
| PostgreSQL | `postgresql+psycopg://user:pass@host:5432/db?sslmode=require` |
| MySQL / MariaDB | `mysql+pymysql://user:pass@host:3306/db?ssl=true` |
| SQLite (file) | `sqlite:///absolute/path/to/file.db` |
| SQLite (read-only) | `sqlite:///file:absolute/path/to/file.db?mode=ro&uri=true` |

## Parameter binding

Use SQLAlchemy named bind parameters (`:name`) for any value that varies between runs. Do **not** use Python string formatting or `${...}` expansion in `query` — the latter is explicitly blocked to foreclose SQL injection.

```yaml
source:
  type: sql
  dsn_env: RECOTEM_RECIPE_DB_DSN
  query: |
    SELECT user_id, item_id, ts
    FROM events
    WHERE ts >= :since
      AND event_type = :event_type
  query_parameters:
    since: ${RECOTEM_RECIPE_SINCE}
    event_type: purchase
```

Only `query_parameters` values undergo `${RECOTEM_RECIPE_*}` expansion. Both `query` and `dsn_env` are unconditionally exempt from expansion regardless of variable name.

Parameter values are bound via SQLAlchemy `text().bindparams(...)`; supported types are `str`, `int`, `float`, and `bool`.

## Read-only enforcement

The DB user should have `SELECT`-only privileges on the relevant tables. Recotem also issues a session-level read-only command before running the query, as defence in depth:

| Dialect | Statement |
|---------|-----------|
| PostgreSQL | `SET TRANSACTION READ ONLY` |
| MySQL | `SET SESSION TRANSACTION READ ONLY` |
| MariaDB | `SET SESSION TRANSACTION READ ONLY` + `SET SESSION max_statement_time = <seconds>` |
| SQLite | `PRAGMA query_only = ON` |

If this command fails (insufficient privilege, or the SQLite pragma cannot be set), training aborts with `DataSourceError`. It is **not** silently skipped. The authoritative trust boundary is still your grant model — never rely solely on the session flag.

## Statement timeouts

| Dialect | Implementation |
|---------|----------------|
| PostgreSQL | `SET LOCAL statement_timeout = <ms>` |
| MySQL | `SET SESSION MAX_EXECUTION_TIME = <ms>` |
| MariaDB | `SET SESSION max_statement_time = <seconds>` (different unit and variable from MySQL) |
| SQLite | Not enforced; emits `sql_statement_timeout_unsupported_on_sqlite` structured warning. |

On PostgreSQL, MySQL, and MariaDB, failure to set the timeout aborts training with `DataSourceError`. SQLite has no server-side timeout primitive — the warning is emitted so operators know the documented safety control is not in effect on this dialect.

## TLS recommendations

TLS is strongly recommended in production. Always set `sslmode=require` (or stricter: `verify-ca`, `verify-full`) on PostgreSQL, or `ssl=true` (or specify a CA bundle via `ssl_ca=...`) on MySQL/MariaDB. Recotem does not enforce TLS — but the source emits a `sql_dsn_tls_not_configured` structlog warning at init when the DSN appears plaintext:

- PostgreSQL: no `sslmode` set, or set to `disable` / `allow` / `prefer`.
- MySQL/MariaDB: no `ssl*` query parameter at all.

Operators with deployment-level TLS (service mesh, sidecar) can silence the warning by adding the explicit DSN flag.

## SSRF guard

By default, DSN hosts that resolve to private / loopback / link-local IPs are rejected. The guard inspects every routing form the libpq / PyMySQL drivers honour — not just the URL netloc:

- `url.host` (the netloc, e.g. `postgresql://u:p@host/db`).
- `?host=name` (libpq for PostgreSQL, PyMySQL for MySQL/MariaDB) — when set, SQLAlchemy's `make_url` leaves `url.host` empty but the driver still routes the TCP connect to the query value.
- `?hostaddr=ip` (libpq) — the actual TCP target IP. If both `host` and `hostaddr` are set, libpq uses `hostaddr` for the connect and `host` only for SNI / TLS certificate validation.

Three routing forms are refused outright because they cannot be resolved to a TCP target the SSRF check can validate, and all amount to local pivots:

- `?service=` (PostgreSQL) — libpq looks up parameters in `pg_service.conf`.
- `?unix_socket=` (MySQL/MariaDB) — connects to a local Unix domain socket.
- `?host=/abs/path` (PostgreSQL) — libpq treats absolute-path values as a Unix-socket directory.

Network-dialect DSNs that contain *no* host information at all (e.g. `postgresql:///db`) are also refused, because libpq / PyMySQL would otherwise default to the local socket / `127.0.0.1`.

::: warning Opt-in for in-cluster destinations
Set `RECOTEM_SQL_ALLOW_PRIVATE=1` (also accepts `true` / `yes` / `on`) to opt in to any of the above. Intended for Docker Compose / Kubernetes service-name destinations, Unix-socket connections, or libpq service files. This env var **also disables the DNS-rebinding re-check** before each probe/fetch — opting in means trusting the host end-to-end.
:::

### DNS rebinding TOCTOU

The SSRF check pins the **full set of resolved public IPs** (IPv4 + IPv6) at init across every candidate routing host. Before each probe/fetch, the effective TCP target (libpq: `hostaddr` > query `host` > netloc; PyMySQL: query `host` > netloc) is re-resolved via `socket.getaddrinfo`; if no address overlaps the pinned set, the run is aborted.

This is a best-effort defence — the SQL driver does its own resolution at connect time, so a sufficiently fast attacker controlling DNS can still rebind between our check and the driver's resolution. Use platform controls (private network access, VPC peering, firewalls) as the authoritative boundary.

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `RECOTEM_RECIPE_*` | — | The env var whose name you set in `dsn_env`. |
| `RECOTEM_MAX_SQL_ROWS` | `50_000_000` | Hard cap on rows returned by the query. Clamp `[1_000, 500_000_000]`. |
| `RECOTEM_SQL_ALLOW_PRIVATE` | (unset) | Truthy values (`1`, `true`, `yes`, `on`) opt into private/loopback DSN hosts. |

## Errors and exit codes

| Error | Exit | Message pattern |
|-------|------|----------------|
| DSN env var not set or empty | 3 | `DataSourceError: env var RECOTEM_RECIPE_DB_DSN is not set or is empty; set it to the database DSN (e.g. postgresql://user:pass@host/db)` |
| Unsupported dialect | 3 | `DataSourceError: unsupported SQL dialect 'oracle'; officially supported: ['mysql', 'postgres', 'sqlite'].` |
| Missing driver for dialect | 3 | `DataSourceError: psycopg driver is required for dialect 'postgresql'. Install it with: pip install 'recotem[postgres]'` |
| Query exceeds row cap | 3 | `DataSourceError: query result exceeds RECOTEM_MAX_SQL_ROWS=50000000 rows; tighten the query or raise the cap` |
| Private/loopback host refused | 3 | `DataSourceError: refusing to connect to private/loopback host '10.0.0.5'; set RECOTEM_SQL_ALLOW_PRIVATE=1 to opt in (intended for in-cluster or compose service-name destinations)` |
| libpq service-file routing refused | 3 | `DataSourceError: DSN routes via libpq service file (?service=...); this bypasses the network SSRF guard. Set RECOTEM_SQL_ALLOW_PRIVATE=1 to opt in.` |
| MySQL Unix-socket routing refused | 3 | `DataSourceError: DSN routes via Unix socket (?unix_socket=...); this bypasses the network SSRF guard. Set RECOTEM_SQL_ALLOW_PRIVATE=1 to opt in.` |
| Absolute-path host refused | 3 | `DataSourceError: DSN host is an absolute path (libpq Unix-socket form); this bypasses the network SSRF guard. Set RECOTEM_SQL_ALLOW_PRIVATE=1 to opt in.` |
| Network DSN with no host refused | 3 | `DataSourceError: DSN for dialect 'postgresql' does not specify a host; the driver would default to the local socket / 127.0.0.1 which is rejected by the SSRF guard. Specify a host explicitly or set RECOTEM_SQL_ALLOW_PRIVATE=1 to opt in.` |
| sqlalchemy not installed | 3 | `DataSourceError: sqlalchemy is required for SQLSource. Install one of: recotem[postgres], recotem[mysql], recotem[sqlite].` |
| Column missing after query | 2 | `RecipeError: column 'item_id' not found in query result` |

All SQL exceptions are wrapped in `DataSourceError` and produce exit 3. The full error type is included in the stderr JSON line. DSN userinfo is redacted from log output by `recotem.log_redaction`.

## Notes

- `recotem validate recipes/my_recipe.yaml` probes the database by issuing `SELECT 1` before training starts. This validates the DSN, driver installation, and host connectivity.
- Query results are read in chunks to bound memory usage during streaming. The chunk size is `min(100_000, RECOTEM_MAX_SQL_ROWS)` so the row cap is enforced before the first chunk is fully loaded.

::: warning Row cap is not a memory cap
`RECOTEM_MAX_SQL_ROWS` caps the total **row count**, not the resulting DataFrame's resident memory. Chunks are accumulated into a list and concatenated at the end, so peak RAM is approximately `total_rows × bytes_per_row`. Trainers with the default cap (50 M rows) should expect ~2.5–5 GiB resident under wide-result queries; with the upper clamp (500 M rows) the same query can require 25 GiB+ of RAM. Tighten the cap or the query columns if you need a memory bound, not just a row bound. Server-side streaming via `stream_results=True` controls only the **wire-level** cursor; the row cap is the right knob for the consumer-side bound.
:::

- `source.query` and `source.dsn_env` are unconditionally exempt from `${...}` expansion regardless of variable name; only `query_parameters` values are expanded.
- `flock` is host-local; across hosts use scheduler-level mutex (`concurrencyPolicy: Forbid` in Kubernetes CronJobs).
