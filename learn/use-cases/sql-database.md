---
title: Recommendations from a SQL Database
description: "SQL database recommendation with Recotem: train a Postgres recommendation model (or MySQL / SQLite) directly from an orders table and serve it over HTTP."
---

# Recommendations from a SQL Database

If your interaction data already lives in a relational database, you do not need an export pipeline to build recommendations. Recotem's `sql` source connects directly to **PostgreSQL, MySQL/MariaDB, or SQLite** through [SQLAlchemy 2](https://www.sqlalchemy.org/), runs a `SELECT` you control, trains a model, and serves it behind a `/v1/recipes/{name}:recommend` HTTP endpoint.

This guide walks through a `postgres recommendation` setup end to end: pointing Recotem at your database with a DSN, shaping an `orders` query into user–item interactions, writing the recipe, and serving live recommendations. The same recipe works for MySQL and SQLite by changing only the connection string.

## What you need

- A database (PostgreSQL, MySQL/MariaDB, or SQLite) with a table of interactions — for example an `orders`, `purchases`, or `events` table that records which user touched which item.
- A **read-only** database user with `SELECT` privilege on the relevant tables.
- Recotem installed with the matching driver extra:

```bash
pip install "recotem[postgres]"   # PostgreSQL (via psycopg)
pip install "recotem[mysql]"      # MySQL / MariaDB (via PyMySQL)
pip install "recotem[sqlite]"     # SQLite (stdlib — no extra driver)
```

Without one of these extras, `recotem train` exits with a `DataSourceError` telling you which extra to install.

## Point Recotem at your database

The connection string (DSN) is **never written into the recipe**. The recipe only names an environment variable; Recotem reads the DSN from it at training time. The variable name must match `^RECOTEM_RECIPE_[A-Z0-9_]+$` — any other prefix is rejected at recipe load.

```bash
export RECOTEM_RECIPE_DB_DSN="postgresql+psycopg://reco_ro:pass@db.internal:5432/shop?sslmode=require"
```

Pick the DSN form for your dialect:

| Dialect | DSN |
|---|---|
| PostgreSQL | `postgresql+psycopg://user:pass@host:5432/db?sslmode=require` |
| MySQL / MariaDB | `mysql+pymysql://user:pass@host:3306/db?ssl=true` |
| SQLite (file) | `sqlite:///absolute/path/to/file.db` |
| SQLite (read-only) | `sqlite:///file:absolute/path/to/file.db?mode=ro&uri=true` |

::: tip Use TLS in production
Set `sslmode=require` (or stricter: `verify-ca`, `verify-full`) on PostgreSQL, or `ssl=true` on MySQL/MariaDB. Recotem does not enforce TLS, but it emits a `sql_dsn_tls_not_configured` warning when the DSN looks plaintext.
:::

### Read-only by design

Give the database user `SELECT`-only privileges — that is the real trust boundary. As defence in depth, Recotem also issues a session read-only command before running your query (`SET TRANSACTION READ ONLY` on PostgreSQL, `SET SESSION TRANSACTION READ ONLY` on MySQL/MariaDB, `PRAGMA query_only = ON` on SQLite). If that command fails, training aborts with a `DataSourceError` rather than continuing — it is never silently skipped.

### Private-host / SSRF guard

By default, DSN hosts that resolve to private, loopback, or link-local IPs are **refused**, and the guard inspects every routing form the drivers honour (netloc, `?host=`, `?hostaddr=`, `?service=`, `?unix_socket=`, and network DSNs with no host at all). This blocks a malicious recipe from pivoting to internal services or a cloud metadata endpoint.

When your database is a Docker Compose or Kubernetes service name, or reached over a Unix socket, opt in explicitly:

```bash
export RECOTEM_SQL_ALLOW_PRIVATE=1
```

::: warning
`RECOTEM_SQL_ALLOW_PRIVATE=1` accepts private/loopback destinations **and** disables the DNS-rebinding re-check. Only set it for hosts you trust end to end. See the [SQL source reference](/docs/data-sources/sql) for the full guard behaviour.
:::

## Shape the interactions query

The `sql` source needs one row per (user, item) interaction. At minimum, select a user column and an item column:

```sql
SELECT user_id, item_id
FROM orders
WHERE status = 'paid'
```

Adding an order timestamp lets Recotem hold out each user's most recent activity for a realistic, time-aware validation split — the closest offline proxy for "recommend what they buy next". Use SQLAlchemy named bind parameters (`:name`) for any value that changes between runs. Do **not** interpolate values into the SQL string yourself: `${...}` expansion is blocked inside `query` specifically to foreclose SQL injection, so bind parameters are the supported path.

```sql
SELECT user_id, item_id, ordered_at
FROM orders
WHERE status = 'paid'
  AND ordered_at >= :since
```

The bind parameter `:since` is supplied from `query_parameters`, which — unlike `query` — does undergo `${RECOTEM_RECIPE_*}` expansion.

## Write the recipe

A recipe is one YAML file: `name` + `source` + `schema` + `training` + `output`. Here is a complete, runnable recipe for the orders query above.

```yaml
name: order_recs

source:
  type: sql
  dsn_env: RECOTEM_RECIPE_DB_DSN
  query: |
    SELECT user_id, item_id, ordered_at
    FROM orders
    WHERE status = 'paid'
      AND ordered_at >= :since
  query_parameters:
    since: ${RECOTEM_RECIPE_SINCE}
  connect_timeout_seconds: 10
  statement_timeout_seconds: 300

schema:
  user_column: user_id
  item_column: item_id
  time_column: ordered_at

cleansing:
  drop_null_ids: true
  dedup: keep_last
  min_rows: 5000
  min_users: 100
  min_items: 50

training:
  algorithms: [IALS, RP3beta, TopPop]
  metric: ndcg
  cutoff: 20
  n_trials: 40
  timeout_seconds: 1800
  split:
    scheme: time_user
    heldout_ratio: 0.1
    seed: 42

output:
  path: ./artifacts/order_recs.recotem
  versioning: append_sha
```

A few notes on the choices above:

- `schema.time_column: ordered_at` is required because the split uses `scheme: time_user`. Because `ordered_at` is a real timestamp column, no `time_unit` is needed. (If your time column is a numeric Unix timestamp, add `time_unit: s`.)
- `algorithms` lists three implicit-feedback learners; Recotem runs an Optuna search across them and keeps the best by `ndcg@20`. `TopPop` is a cheap popularity baseline that guards against a model that never beats "just show the bestsellers". Other options include `CosineKNN`, `DenseSLIM`, `TruncatedSVD`, and `BPRFM`.
- `cleansing.min_rows` / `min_users` / `min_items` are data preconditions — if the query returns too little data, training fails fast instead of producing a weak model.

Every field is documented in the [Recipe Reference](/docs/recipe-reference), and every SQL-specific detail (timeouts, row cap, error codes) in the [SQL source reference](/docs/data-sources/sql).

## Train and serve

First generate a signing key so artifacts are tamper-evident, and an API key for the server:

```bash
recotem keygen --type signing
recotem keygen --type api

export RECOTEM_SIGNING_KEYS="dev:<hex64>"
export RECOTEM_API_KEYS="key1:sha256:<hex64>"
```

Validate connectivity before a long run — `recotem validate` issues a `SELECT 1` against your DSN to confirm the driver, credentials, and host all work:

```bash
export RECOTEM_RECIPE_DB_DSN="postgresql+psycopg://reco_ro:pass@db.internal:5432/shop?sslmode=require"
export RECOTEM_RECIPE_SINCE="2026-01-01"

recotem validate recipes/order_recs.yaml
recotem train recipes/order_recs.yaml
```

Training writes a signed artifact to `./artifacts/order_recs.recotem`. Point `recotem serve` at a directory of recipes and it loads the artifact each recipe produced:

```bash
recotem serve --recipes ./recipes/ --port 8080
```

## Get recommendations

Call the recipe's `:recommend` endpoint with the API key you generated. The `user_id` must be one seen during training:

```bash
curl -s -X POST http://localhost:8080/v1/recipes/order_recs:recommend \
  -H "X-API-Key: <plaintext>" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "u1", "limit": 10}' | jq .
```

```json
{
  "request_id": "a1b2c3d4e5f6",
  "recipe": "order_recs",
  "model_version": "sha256:a3f2...e91d",
  "items": [
    {"item_id": "item-42", "score": 0.91},
    {"item_id": "item-17", "score": 0.84}
  ]
}
```

Items are ordered by descending `score`. A `404 UNKNOWN_USER` for a brand-new customer is expected — handle it in your app by falling back to popularity. The full request/response contract, related-item and batch verbs, and error codes are in the [Serving API reference](/docs/serving-api).

## Schedule regular retraining

Your `orders` table keeps growing, so the model should be retrained on a schedule. `recotem train` is an ordinary process with a well-defined exit-code contract, so any scheduler works. See [cron / systemd Deployment](/docs/deployment/cron-systemd) for cron and systemd-timer setups that source secrets safely and react to non-zero exit codes.

::: tip Across multiple hosts
Recotem's per-recipe lock is host-local (`flock`). If a scheduled train job can run on more than one machine, add a scheduler-level mutex (in Kubernetes, `concurrencyPolicy: Forbid` on the CronJob) so two runs never write the same artifact at once.
:::

## Next steps

- [SQL source reference](/docs/data-sources/sql) — timeouts, `RECOTEM_MAX_SQL_ROWS`, the SSRF guard, and every error code.
- [Recipe Reference](/docs/recipe-reference) — every field, type, and default.
- [Serving API reference](/docs/serving-api) — endpoints, auth, and response shapes.
- [cron / systemd Deployment](/docs/deployment/cron-systemd) — schedule retraining.
- Prefer a warehouse over an operational database? See [Product Recommendations from GA4 + BigQuery](/learn/use-cases/ga4-bigquery), or browse all guides in the [Learn hub](/learn/).
