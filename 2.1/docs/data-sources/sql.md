---
title: SQL Source
description: "Train Recotem recommenders directly from PostgreSQL, MySQL, or SQLite using the SQL data source built on SQLAlchemy 2."
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
    since: "2026-04-01"
  connect_timeout_seconds: 10
  statement_timeout_seconds: 300
```

| Field | Required | Default | Notes |
|---|---|---|---|
| `dsn_env` | yes | — | Name of an env var matching `^RECOTEM_RECIPE_[A-Z0-9_]+$` containing the DSN. The DSN itself is never written to the recipe. |
| `query` | yes | — | Raw SQL. Never subject to `${...}` expansion (SQL injection foreclosure). |
| `query_parameters` | no | `{}` | Bound via SQLAlchemy `text().bindparams(...)`. Never subject to `${...}` expansion — values are used exactly as written. |
| `connect_timeout_seconds` | no | `10` | Valid range `[1, 60]`. Out-of-range raises `ValidationError`. Passed as `connect_timeout` (PG/MySQL) or `timeout` (SQLite). |
| `statement_timeout_seconds` | no | `300` | Valid range `[1, 1800]`. See [Statement timeouts](#statement-timeouts) for per-dialect details. |

## DSN examples

| Dialect | DSN |
|---|---|
| PostgreSQL | `postgresql+psycopg://user:pass@host:5432/db?sslmode=require` |
| MySQL | `mysql+pymysql://user:pass@host:3306/db?ssl_ca=/path/to/ca.pem` |
| MariaDB | `mariadb+pymysql://user:pass@host:3306/db?ssl_ca=/path/to/ca.pem` — `mysql+pymysql://` also works and reaches the same server |
| SQLite (file) | `sqlite:///absolute/path/to/file.db` |
| SQLite (read-only) | `sqlite:///file:absolute/path/to/file.db?mode=ro&uri=true` |

The MySQL / MariaDB row(s) above assume `/path/to/ca.pem` is a CA **you** issued the server certificate from, and that the certificate names the host the DSN connects to. A server still presenting the certificate it generated for itself needs more than `ssl_ca` — see [Turning TLS on when the server uses its own certificate](#turning-tls-on-when-the-server-uses-its-own-certificate).

**The `+driver` suffix is required, not decorative.** A bare scheme picks
SQLAlchemy's default DBAPI, and for every dialect except SQLite that default is
a driver recotem does not install: `postgresql://` routes to `psycopg2` (the
extra ships psycopg v3), and `mysql://` / `mariadb://` route to `mysqldb` (the
extra ships PyMySQL). Recotem refuses such a DSN up front, naming the driver
and the spelling to use. `postgres://` is refused outright — SQLAlchemy 2.x
removed that dialect alias, so no suffix can rescue it.

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
    since: "2026-04-01"
    event_type: purchase
```

Parameter values are bound via SQLAlchemy `text().bindparams(...)`; supported types are `str`, `int`, `float`, and `bool`.

::: warning `query_parameters` values are literals, not templates
`${RECOTEM_RECIPE_*}` expansion is suppressed inside `query_parameters` exactly as it is inside `query` — both keys are on the loader's no-expand list, at every nesting level. A recipe that writes `since: ${RECOTEM_RECIPE_SINCE}` binds the literal string `${RECOTEM_RECIPE_SINCE}` as the parameter value; the environment variable is never read.

What that produces is not always loud. Against a text date column, `ts >= '${RECOTEM_RECIPE_SINCE}'` is true for every row — `$` sorts below every digit — so the run loads the entire table and exits **0** having silently trained on the whole history. Flip the comparison to `<=` and it matches nothing: `DataSourceError: source 'sql' returned no rows`, exit 3.

For a window that moves with each run, express it in the SQL — `WHERE ts >= CURRENT_DATE - INTERVAL '90 days'` (PostgreSQL), `WHERE ts >= CURRENT_DATE - INTERVAL 90 DAY` (MySQL / MariaDB), `WHERE ts >= date('now', '-90 days')` (SQLite) — or render the recipe from a template before calling `recotem train`. `${RECOTEM_RECIPE_*}` **is** expanded in `source.path`, `output.path`, and `item_metadata.path`; only `query`, `query_parameters`, and `dsn_env` are withheld.
:::

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

TLS is strongly recommended in production. Always set `sslmode=require` (or stricter: `verify-ca`, `verify-full`, which additionally need `sslrootcert=`) on PostgreSQL, or `ssl_ca=/path/to/ca.pem` (or `ssl_verify_cert=true` to verify against the system CA store) on MySQL/MariaDB. Read [Turning TLS on when the server uses its own certificate](#turning-tls-on-when-the-server-uses-its-own-certificate) before copying either — the stricter spellings fail against a server that has not been issued a certificate by a CA you control. **`?ssl=true` is not a usable spelling** — PyMySQL's `ssl` connection parameter takes a mapping or an `ssl.SSLContext`, never a string, and SQLAlchemy passes a URL query value through as the string it was written as. Any non-empty scalar `ssl=` value therefore fails inside the driver, before it opens a socket, with `AttributeError: 'str' object has no attribute 'get'`. Use the `ssl_*` per-option keys instead. Recotem 2.1.0 refuses such a DSN up front with exit 3, naming the parameter and the fix, rather than leaving the bare `AttributeError` to reach the operator. Recotem does not enforce TLS — but the source emits a `sql_dsn_tls_not_configured` structlog warning at init when nothing in the DSN *forces* TLS:

- PostgreSQL: no `sslmode` set, or set to `disable` / `allow` / `prefer`.
- MySQL/MariaDB: no `ssl*` query parameter at all.

The warning does not mean the connection is plaintext: psycopg defaults to `sslmode=prefer` and PyMySQL to its PREFERRED mode, so both attempt TLS on their own — they just fall back to plaintext, silently, against a server that does not offer it. Operators with deployment-level TLS (service mesh, sidecar) can silence the warning by adding the explicit DSN flag.

### Turning TLS on when the server uses its own certificate

A server that has `require_secure_transport` (MySQL / MariaDB) or an `hostssl`-only `pg_hba.conf` (PostgreSQL) turned on and nothing else presents the certificate it generated for itself. That certificate is not issued by any CA the client trusts and names no host, so the strict spellings above refuse it:

| DSN query | MySQL 8.4 (`require_secure_transport=ON`) | MariaDB 11.8 (`require_secure_transport=ON`) |
|---|---|---|
| *(none)* | connects (driver PREFERRED mode) | connects (driver PREFERRED mode) |
| `?ssl_ca=<the server's own ca.pem>` | **fails** — `CERTIFICATE_VERIFY_FAILED … IP address mismatch` | **no such file** — MariaDB writes none |
| `?ssl_ca=<…>&ssl_check_hostname=false` | connects | still fails (no CA file exists) |
| `?ssl_verify_cert=true` | **fails** — `self-signed certificate in certificate chain` | **fails** — `self-signed certificate` |
| `?ssl_check_hostname=false` alone | connects | connects |
| `?ssl_verify_cert=false` | connects | connects |

MySQL writes `ca.pem` and `server-cert.pem` into its data directory, but the certificate's CN is `MySQL_Server_<version>_Auto_Generated_Server_Certificate` with no SAN, so SQLAlchemy's default `ssl_check_hostname=True` rejects it. MariaDB generates its certificate in memory: `@@ssl_ca` and `@@ssl_cert` are `NULL` and no `.pem` is written, so there is nothing for `ssl_ca` to name.

`ssl_check_hostname=false` and `ssl_verify_cert=false` keep the channel encrypted but stop authenticating the server, which leaves the connection open to an active machine-in-the-middle. Treat them as a way to get encrypted quickly, then issue a server certificate from a CA you control — naming the host in the SAN — and point `ssl_ca` at that CA. With such a certificate `?ssl_ca=/path/to/ca.pem` alone connects, which is the form the DSN table above shows.

The same shape applies to PostgreSQL: `sslmode=require` encrypts without authenticating, and `verify-ca` / `verify-full` need a root certificate to check against. With `sslrootcert` unset, libpq looks for `~/.postgresql/root.crt` and refuses the connection when that file is absent — so add `&sslrootcert=/path/to/root.crt`, or `&sslrootcert=system` to use the OS trust store.

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
| DSN env var not set or empty | 3 | `DataSourceError: env var RECOTEM_RECIPE_DB_DSN is not set or is empty; set it to the database DSN (e.g. postgresql+psycopg://user:pass@host/db). The +driver suffix is required: a bare postgresql:// or mysql:// DSN routes to a driver recotem does not install` |
| Unsupported dialect | 3 | `DataSourceError: unsupported SQL dialect 'oracle'; supported DSN forms: ['mariadb+pymysql://', 'mysql+pymysql://', 'postgresql+psycopg://', 'sqlite:///'].` |
| `postgres://` alias | 3 | `DataSourceError: SQL dialect 'postgres' was removed in SQLAlchemy 2.x and cannot be loaded by any driver. Use postgresql+psycopg:// instead.` |
| DSN routes to an uninstalled driver | 3 | `DataSourceError: cannot load the 'psycopg2' driver for dialect 'postgresql': postgresql:// with no +driver suffix defaults to 'psycopg2', which recotem does not install. Write the DSN as postgresql+psycopg:// to use the driver pip install 'recotem[postgres]' provides, or install 'psycopg2' yourself.` |
| DSN names a driver recotem does not probe | 3 | `DataSourceError: unknown SQL driver 'os' in the DSN for dialect 'postgresql'. recotem probes a fixed set of drivers and will not import a name supplied by the DSN. Known drivers: ['mysqldb', 'psycopg', 'psycopg2', 'pymysql', 'pysqlite', 'pysqlite_numeric']. Write the DSN as postgresql+psycopg:// instead.` |
| DSN hostname does not resolve | 3 | `DataSourceError: hostname 'db.internal' does not resolve; verify the DSN host or set RECOTEM_SQL_ALLOW_PRIVATE=1 to bypass for offline tests` |
| Query exceeds row cap | 3 | `DataSourceError: query result exceeds RECOTEM_MAX_SQL_ROWS=50000000 rows; tighten the query or raise the cap` |
| Private/loopback host refused | 3 | `DataSourceError: refusing to connect to private/loopback host '10.0.0.5'; set RECOTEM_SQL_ALLOW_PRIVATE=1 to opt in (intended for in-cluster or compose service-name destinations)` |
| libpq service-file routing refused | 3 | `DataSourceError: DSN routes via libpq service file (?service=...); this bypasses the network SSRF guard. Set RECOTEM_SQL_ALLOW_PRIVATE=1 to opt in.` |
| MySQL Unix-socket routing refused | 3 | `DataSourceError: DSN routes via Unix socket (?unix_socket=...); this bypasses the network SSRF guard. Set RECOTEM_SQL_ALLOW_PRIVATE=1 to opt in.` |
| Absolute-path host refused | 3 | `DataSourceError: DSN host is an absolute path (libpq Unix-socket form); this bypasses the network SSRF guard. Set RECOTEM_SQL_ALLOW_PRIVATE=1 to opt in.` |
| Network DSN with no host refused | 3 | `DataSourceError: DSN for dialect 'postgresql' does not specify a host; the driver would default to the local socket / 127.0.0.1 which is rejected by the SSRF guard. Specify a host explicitly or set RECOTEM_SQL_ALLOW_PRIVATE=1 to opt in.` |
| sqlalchemy not installed | 3 | `DataSourceError: sqlalchemy is required for SQLSource. Install one of: recotem[postgres], recotem[mysql], recotem[sqlite].` |
| Scalar `?ssl=` on MySQL/MariaDB | 3 | `DataSourceError: DSN for dialect 'mysql' sets ?ssl= to a scalar value; the driver's ssl parameter takes a mapping or an SSLContext, so any non-empty scalar fails inside the driver with an unhelpful AttributeError. Add ?ssl_ca=/path/to/ca.pem ...` |
| Column missing after query | 3 | `DataSourceError: schema column(s) ['ts'] not found in the fetched data for recipe '<name>'; available columns: [...]` |

All SQL exceptions are wrapped in `DataSourceError` and produce exit 3. The full error type is included in the stderr JSON line. DSN userinfo is redacted from log output by `recotem.log_redaction`.

## Notes

- `recotem validate recipes/my_recipe.yaml` probes the database by issuing `SELECT 1` before training starts. This validates the DSN, driver installation, and host connectivity.
- Query results are read in chunks to bound memory usage during streaming. The chunk size is `min(100_000, RECOTEM_MAX_SQL_ROWS)` so the row cap is enforced before the first chunk is fully loaded.

::: warning Row cap is not a memory cap
`RECOTEM_MAX_SQL_ROWS` caps the total **row count**, not the resulting DataFrame's resident memory. Chunks are accumulated into a list and concatenated at the end, so peak RAM is approximately `total_rows × bytes_per_row`. Trainers with the default cap (50 M rows) should expect ~2.5–5 GiB resident under wide-result queries; with the upper clamp (500 M rows) the same query can require 25 GiB+ of RAM. Tighten the cap or the query columns if you need a memory bound, not just a row bound. Server-side streaming via `stream_results=True` controls only the **wire-level** cursor; the row cap is the right knob for the consumer-side bound.
:::

- `source.query`, `source.query_parameters`, and `source.dsn_env` are all exempt from `${...}` expansion regardless of variable name: `query` and `query_parameters` are on the recipe loader's global no-expand list, and the SQL source adds `dsn_env` to it. See [Parameter binding](#parameter-binding).
- `flock` is host-local; across hosts use scheduler-level mutex (`concurrencyPolicy: Forbid` in Kubernetes CronJobs).
