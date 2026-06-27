---
title: BigQuery Source
---

# BigQuery Source

## Install

```bash
pip install "recotem[bigquery]"
```

Without this extra, `recotem train` exits with one of these (depending on which package is missing):

```
DataSourceError: google-cloud-bigquery is required for BigQuerySource. Install it with: pip install recotem[bigquery]
DataSourceError: db-dtypes is required for BigQuerySource. Install it with: pip install recotem[bigquery]
```

## Authentication

Recotem uses Application Default Credentials (ADC). No credentials are embedded in recipes. The `google-cloud-bigquery` client itself walks the standard ADC chain (`GOOGLE_APPLICATION_CREDENTIALS` → `gcloud` user creds → metadata server) — Recotem does not consult any of these env vars directly.

Set up ADC with one of:

```bash
# Local development
gcloud auth application-default login

# Service account key (not recommended for production)
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json

# GCE / GKE / Cloud Run / Vertex AI
# No action needed. The metadata server provides credentials automatically.
```

`source.project` (recipe field) is forwarded as the BigQuery client's billing project. When omitted, the client uses the ADC ambient project (`gcloud config get project` for user creds, or the service account's project). There is no recipe field for `location` — BigQuery infers location from the dataset referenced in the query.

Required IAM role on the BigQuery dataset: `roles/bigquery.dataViewer` + `roles/bigquery.jobUser` on the project.

For the Storage Read API (used for large result sets): `roles/bigquery.readSessionUser`. This role is **optional** — the fetch path tries `create_bqstorage_client=True` first. Storage Read API failures map to fallback **only for IAM-shape failures** (PermissionDenied / Forbidden / 403); quota errors, 5xx backend failures, and other non-permission errors raise `DataSourceError` so REST fallback does not double-bill. Set `RECOTEM_BQ_REQUIRE_STORAGE_API=1` to disable the IAM-fallback path entirely (requires `bigquery.readSessions.create` permission).

Recommended minimum set for a service account used by Recotem:

| Role | Scope |
|------|-------|
| `roles/bigquery.jobUser` | Project |
| `roles/bigquery.dataViewer` | Dataset(s) queried |
| `roles/bigquery.readSessionUser` | Project (for Storage Read API) |

## Recipe configuration

```yaml
source:
  type: bigquery
  query: |
    SELECT ...
  query_parameters:        # optional
    key: value
  project: my-gcp-project  # optional; falls back to ADC ambient project
```

## Parameter binding

Use BigQuery named parameters (`@name`) for any value that varies between runs. Do **not** use Python string formatting or `${...}` expansion in `query` — neither is supported and the latter is explicitly blocked.

```yaml
source:
  type: bigquery
  query: |
    SELECT user_id, item_id, ts
    FROM `proj.dataset.events`
    WHERE event_date BETWEEN @start_date AND @end_date
      AND event_name = @event_name
  query_parameters:
    start_date: "2026-04-01"
    end_date: "2026-05-07"
    event_name: "purchase"
```

Parameter types are inferred from the Python type of the value:

| YAML / Python type | BigQuery type |
|--------------------|---------------|
| `bool` (`true` / `false`) | `BOOL` |
| `int` | `INT64` |
| `float` | `FLOAT64` |
| `str` | `STRING` |

`bool` is checked before `int` (so YAML `true` does not become `INT64 1`). Lists, dicts, `null`, dates, and timestamps are **not** supported and raise `DataSourceError` whenever the parameter dispatcher runs — that means both at `recotem validate` (via `probe()`) and at fetch time. Encode dates as `STRING` (e.g. `"2026-04-01"`) and parse them in SQL with `PARSE_DATE`, or compute date ranges in SQL via `CURRENT_DATE()` / `DATE_SUB()` (see the GA4 example below).

YAML quoting matters: `lookback_days: 30` is `INT64`, `lookback_days: "30"` is `STRING`. Mismatching the SQL parameter type fails the dry-run with a `Query parameter '@lookback_days' has type STRING which differs from declared type INT64`-style message.

## GA4 events_* pattern

GA4 exports to BigQuery using date-sharded tables named `events_YYYYMMDD`. Use `_TABLE_SUFFIX` to filter by date range without a full table scan.

### Where `item_id` comes from

Recotem reads the DataFrame returned by your query and expects the columns named in `schema` to exist **verbatim** — there is **no recipe-level field for regex, expressions, or derived columns** (`schema` accepts only `user_column`, `item_column`, `time_column`, `time_unit`). The BigQuery source also does **not** pre-validate that those columns are present in the result. Any extraction or reshaping must therefore happen **inside the SQL query** using BigQuery functions such as `REGEXP_EXTRACT`, and the `SELECT` aliases must match the names you reference in `schema`.

### Recommended: derive `item_id` from `page_location`

`page_location` (the page URL) is recorded on every `page_view` event in any GA4 export with **no extra tagging or GTM configuration**, which makes it the most portable signal for building a "users who viewed this also viewed…" recommender straight from raw access logs. The simplest, fully general choice is to use the URL **path** as the item:

```yaml
source:
  type: bigquery
  project: my-project
  query: |
    SELECT
      user_pseudo_id                                                    AS user_id,
      REGEXP_EXTRACT(
        (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_location'),
        r'^https?://[^/]+([^?#]*)'                       -- path only; drop host, query, fragment
      )                                                                 AS item_id,
      TIMESTAMP_MICROS(event_timestamp)                                 AS ts
    FROM
      `my-project.analytics_123456789.events_*`
    WHERE
      _TABLE_SUFFIX BETWEEN
        FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY))
        AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())
      AND event_name = 'page_view'
```

```yaml
schema:
  user_column: user_id
  item_column: item_id
  time_column: ts
cleansing:
  drop_null_ids: true   # REGEXP_EXTRACT returns NULL on no match — drop those rows
```

This covers a rolling 30-day window with no parameter binding (dates are computed in SQL) and treats each distinct path as one item. `drop_null_ids` defaults to `true`; see [Recipe Reference → cleansing](../recipe-reference#cleansing).

If your URLs embed a **stable identifier** (product / article / content ID) you can extract just that ID for a tighter, slug-independent item space. Match on a delimiter so unrelated digits in the URL (e.g. the `2026` in a `/2026/04/12/` date path) are not picked up:

```sql
-- .../articles/12345-some-title       -> "12345"  (numeric ID after a path segment)
REGEXP_EXTRACT(page_location, r'/articles/(\d+)')

-- .../some-title-(A12B)/              -> "A12B"   (4-char alphanumeric ID in parentheses;
--                                                  also matches full-width （ ）)
REGEXP_EXTRACT(page_location, r'[（(]([0-9A-Z]{4})[）)]')
```

Adapt the pattern to your own URL scheme. RE2 (BigQuery's regex engine) supports `\d`, character classes, and UTF-8 literals such as full-width parentheses.

### Alternative: a custom event parameter

If you already emit a dedicated identifier as a custom event parameter (this requires GA4 / GTM configuration on the site), read it from `event_params` instead. Replace the type accessor (`value.int_value` / `value.string_value`) to match how the parameter was sent:

```yaml
source:
  type: bigquery
  project: my-project
  query: |
    SELECT
      user_pseudo_id                                                   AS user_id,
      (SELECT value.int_value
         FROM UNNEST(event_params)
        WHERE key = 'article_id')                                      AS item_id,
      TIMESTAMP_MICROS(event_timestamp)                                AS ts
    FROM
      `my-project.analytics_123456789.events_*`
    WHERE
      _TABLE_SUFFIX BETWEEN
        FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY))
        AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())
      AND event_name = 'select_content'
      AND (SELECT value.int_value
             FROM UNNEST(event_params)
            WHERE key = 'article_id') IS NOT NULL
```

Map the output columns in `schema` exactly as in the `page_location` example above.

## Serving and recommending

Once `recotem train` has written a signed artifact, point `recotem serve` at a directory of recipes and call the recipe's `:recommend` endpoint. The recipe `name` is the stem of the recipe YAML filename:

```bash
curl -X POST http://localhost:8080/v1/recipes/{name}:recommend \
     -H "X-API-Key: <plaintext-api-key>" \
     -H "Content-Type: application/json" \
     -d '{"user_id": "<a user value seen during training>", "limit": 10}'
```

- `user_id` is whatever you mapped in `schema.user_column` (for GA4 this is commonly `user_pseudo_id`). A user not seen during training returns `404 UNKNOWN_USER`.
- To get item-to-item recommendations without a user, call `:recommend-related` with a `seed_items` list of known `item_id` values.
- Without `RECOTEM_API_KEYS` configured the server binds to loopback (`127.0.0.1`) and accepts unauthenticated requests.

See the [Serving API](../serving-api) reference for full request/response shapes and the [Operations](../operations) guide for API-key configuration.

## Errors and exit codes

| Error | Exit | Message pattern |
|-------|------|----------------|
| ADC credentials not found | 3 | `DataSourceError: Could not obtain credentials. Run 'gcloud auth application-default login' or set GOOGLE_APPLICATION_CREDENTIALS.` |
| Permission denied on dataset | 3 | `DataSourceError: Access Denied: Dataset my-project:analytics_123456789` |
| Query syntax error | 3 | `DataSourceError: Syntax error: ...` |
| `schema` column missing from query result | 1 | Unhandled error (`code: internal_error`). The BigQuery source does not validate columns — a `SELECT` alias that does not match `schema` surfaces downstream during cleansing, not as a `RecipeError`. |
| Extra not installed | 3 | `DataSourceError: google-cloud-bigquery is required for BigQuerySource` (or `db-dtypes is required for BigQuerySource`) |

All BigQuery exceptions are wrapped in `DataSourceError` and produce exit 3. The full BigQuery error message is included in the stderr JSON line.

## Storage Read API fallback policy

Recotem tries the BigQuery Storage Read API (`create_bqstorage_client=True`) first for efficiency with large result sets. The fallback to the standard REST API is **selective**, not unconditional:

- **IAM-shape failures** (PermissionDenied / Forbidden / HTTP 403): the Storage Read API is silently skipped and the REST path is used instead. This covers the common case where `roles/bigquery.readSessionUser` is not granted.
- **All other failures** (quota exceeded, 5xx backend errors, network timeouts, etc.): `DataSourceError` is raised immediately without attempting the REST fallback. This prevents a quota-exceeded Storage Read API call from silently double-billing by retrying over REST.

To enforce Storage Read API usage and disable the IAM-fallback path entirely, set:

```bash
export RECOTEM_BQ_REQUIRE_STORAGE_API=1
```

When this variable is truthy (`1`, `true`, `yes`, `on`), any Storage Read API failure raises `DataSourceError` instead of falling back to REST. Use this setting when the service account is expected to hold `bigquery.readSessions.create` and you want hard enforcement.

## Notes

- `recotem validate recipes/my_recipe.yaml` probes ADC authentication and submits the query as a BigQuery dry-run job (`use_query_cache=False`) before any training starts. Dry-run jobs are not billed and do not execute the query. The dry-run also validates `query_parameters` types — invalid types surface here rather than at fetch.
- The dry-run does **not** expose its `total_bytes_processed` estimate to the user. Recotem also does not set `maximum_bytes_billed`, so a runaway query is bounded only by your project's BigQuery quotas. Add `--maximum-bytes-billed`-style guard rails at the GCP project level if cost runaway is a concern.
- Query results are streamed via the Storage Read API when available. Very large result sets (> 10 M rows) should be pre-aggregated in your data warehouse before handing off to Recotem.
- `GOOGLE_*` and `GCP_*` env vars are blacklisted from recipe `${...}` expansion (case-insensitive). Cloud credentials must come from ADC, not from the recipe file. `source.query` and `source.query_parameters` are unconditionally exempt from `${...}` expansion regardless of variable name.
