---
title: Serving API
---

# Serving API

`recotem serve` exposes a FastAPI application over HTTP. All endpoints are documented here with their request/response shapes, authentication requirements, and error codes.

## Authentication

API key authentication uses the `X-API-Key` request header. Keys are configured via `RECOTEM_API_KEYS` as a comma-separated list of `<kid>:sha256:<hex64>` entries. The server verifies the submitted plaintext against the stored scrypt hash.

When `RECOTEM_API_KEYS` is empty:
- The server forces `127.0.0.1` as the bind host regardless of `RECOTEM_HOST`.
- All requests from `127.0.0.1` are accepted without a key.
- Use `--insecure-no-auth` with `RECOTEM_ENV` set to `development`, `dev`, or `test` to disable auth explicitly in local development.

::: warning
Trailing or leading whitespace in the `X-API-Key` header is treated as part of the key and will not match. Trim values client-side before sending.
:::

## Common headers

| Header | Direction | Description |
|--------|-----------|-------------|
| `X-API-Key` | Request | Authentication token (plaintext). Required on all authenticated endpoints. |
| `X-Request-ID` | Request (optional) | Client-supplied request identifier. Must match `[A-Za-z0-9_-]{1,64}`. Values that do not match are replaced with a freshly generated UUID4. |
| `X-Request-ID` | Response | Echo of the request ID used internally — either the validated client-supplied value or the generated UUID4. |
| `X-Recotem-Metadata-Degraded` | Response | Set to `1` when one or more items in the response had a metadata lookup failure (item was present in training but the metadata join failed for that item). The `items` list still includes those items with only `item_id` and `score`. |

## Endpoints

### POST /predict/{name}

Get top-K recommendations for a single user.

**Authentication:** Required (`X-API-Key`).

**Path parameters:**

| Parameter | Type | Constraints | Description |
|-----------|------|-------------|-------------|
| `name` | string | `[A-Za-z0-9_-]{1,64}` | Recipe name (stem of the recipe YAML filename). |

**Request body:**

```json
{
  "user_id": "u1",
  "cutoff": 10
}
```

| Field | Type | Constraints | Default | Description |
|-------|------|-------------|---------|-------------|
| `user_id` | string | required | — | User identifier as seen in training data. |
| `cutoff` | integer | 1–1000 | `10` | Number of items to return. |

**Response body (200 OK):**

```json
{
  "items": [
    {
      "item_id": "item-42",
      "score": 0.9812,
      "title": "Example Item",
      "category": "news"
    },
    {
      "item_id": "item-17",
      "score": 0.8754
    }
  ],
  "model": {
    "recipe": "news_articles",
    "trained_at": "2026-05-07T01:23:45Z",
    "best_class": "IALSRecommender",
    "kid": "prod-2026-q2"
  },
  "request_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

The `items` array is ordered by descending `score`. Each item always contains `item_id` and `score`; additional fields are joined from the item metadata configured in the recipe (`item_metadata` block). Fields listed in `RECOTEM_METADATA_FIELD_DENY` are stripped before the response is sent. A metadata column named `item_id` or `score` cannot shadow the trusted recommender values.

**Status codes:**

| Code | Condition | Response body `code` field |
|------|-----------|---------------------------|
| 200 | Success | — |
| 401 | Missing or invalid `X-API-Key` | `missing_api_key` or `invalid_api_key` |
| 404 | `user_id` was not present in training data | `user_not_found` |
| 422 | Request body failed schema validation (missing `user_id`, `cutoff` out of range) | — (FastAPI default validation envelope) |
| 503 | Recipe is not loaded or unhealthy | `recipe_unavailable` |

**curl example:**

```bash
curl -s -X POST http://localhost:8080/predict/news_articles \
  -H "X-API-Key: <plaintext>" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "u1", "cutoff": 10}' | jq .
```

::: tip 404 user_not_found
A 404 response for an unknown user is expected for new users not seen during training. Handle this in your application layer — for example, fall back to popularity-based recommendations. The 404 is not an error condition on the server side.
:::

---

### GET /health

Overall health status. Safe for Kubernetes readiness and liveness probes.

**Authentication:** None (unauthenticated).

**Response body (200 OK or 503 Service Unavailable):**

```json
{
  "status": "ok",
  "total": 3,
  "loaded": 3
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"ok"` \| `"degraded"` | `"ok"` when every registered recipe is loaded and error-free. `"degraded"` when any recipe is unloaded or carries a load error. |
| `total` | integer | Total number of recipe entries known to the registry. |
| `loaded` | integer | Number of recipes successfully loaded and ready to serve predictions. |

**Status codes:**

| Code | Condition |
|------|-----------|
| 200 | All registered recipes are loaded and error-free. |
| 503 | One or more recipes are unloaded or carry a load error. |

::: tip
Use HTTP status code only for probe logic. A `status: degraded` response returns 503, which causes Kubernetes readiness probes to remove the pod from the Service endpoints. This is intentional — a pod where every predict call returns 503 should not receive traffic.
:::

**curl example:**

```bash
curl -s http://localhost:8080/health | jq .
```

---

### GET /health/details

Per-recipe health detail including `kid`, `trained_at`, `best_class`, and load errors.

**Authentication:** Required (`X-API-Key`).

Per-recipe detail is behind authentication because it includes artifact key identifiers (`kid`) which should not be publicly discoverable. Use `GET /health` for unauthenticated probe-safe status.

**Response body (200 OK or 503):**

```json
{
  "status": "ok",
  "recipes": {
    "news_articles": {
      "loaded": true,
      "trained_at": "2026-05-07T01:23:45Z",
      "best_class": "IALSRecommender",
      "kid": "prod-2026-q2"
    },
    "product_recs": {
      "loaded": false,
      "error": "signature mismatch"
    }
  }
}
```

Every recipe found in the recipes directory appears here, regardless of whether its artifact loaded — startup-failed recipes appear as stubs with `loaded: false` and an `error` field. Optional fields (`trained_at`, `best_class`, `kid`, `error`) are present only when their underlying value is set; absent fields imply the corresponding value is unset.

**Status codes:** Same as `GET /health` — 503 when any recipe is unloaded or carries a load error.

**curl example:**

```bash
curl -s http://localhost:8080/health/details \
  -H "X-API-Key: <plaintext>" | jq .
```

---

### GET /models

List metadata for all currently loaded models.

**Authentication:** Required (`X-API-Key`).

Stub entries for recipes whose artifact failed to load at startup are excluded — they appear in `/health/details` instead.

**Response body (200 OK):**

```json
[
  {
    "name": "news_articles",
    "recipe_name": "news_articles",
    "recipe_hash": "ab12cd34...",
    "trained_at": "2026-05-07T01:23:45Z",
    "best_class": "IALSRecommender",
    "best_params": { "alpha": 1.0 },
    "best_score": 0.1234,
    "metric": "ndcg",
    "cutoff": 20,
    "tuning": { "tried_algorithms": ["IALS", "TopPop"], "n_trials": 40, "n_completed": 40 },
    "data_stats": { "n_rows": 12345, "n_users": 678, "n_items": 90 },
    "kid": "prod-2026-q2",
    "recotem_version": "2.0.0",
    "irspack_version": "0.3.14"
  }
]
```

Each entry is the artifact header JSON plus the registered recipe `name` and the active `kid`. No key material is included. The header schema is documented in [Architecture — Artifact format](./#artifact-format).

**curl example:**

```bash
curl -s http://localhost:8080/models \
  -H "X-API-Key: <plaintext>" | jq .
```

---

### GET /metrics

Prometheus metrics exposition (opt-in).

**Authentication:** None (unauthenticated).

**Availability:** Only registered when both conditions are met:
1. `RECOTEM_METRICS_ENABLED` is set to a truthy value (`1`, `true`, `yes`, `on`).
2. The `recotem[metrics]` extra is installed (`pip install "recotem[metrics]"`).

This endpoint is excluded from the OpenAPI schema (`include_in_schema=False`).

::: warning Network exposure
`/metrics` and `/health` are unauthenticated by design — the same posture Prometheus and Kubernetes liveness/readiness probes expect. These endpoints surface recipe names, kid IDs, load-error strings, model-load timestamps, and predict-latency histograms. Restrict them with your cluster's NetworkPolicy rather than relying on the API-key middleware.
:::

**Available metrics:**

| Metric | Type | Labels |
|--------|------|--------|
| `recotem_predict_total` | Counter | `recipe`, `status` |
| `recotem_predict_latency_seconds` | Histogram | `recipe` |
| `recotem_model_loaded` | Gauge | `recipe` |
| `recotem_artifact_load_failures_total` | Counter | `recipe` |
| `recotem_active_recipes` | Gauge | — |
| `recotem_swap_total` | Counter | `recipe`, `result` |
| `recotem_artifact_stat_failures_total` | Counter | `recipe` |
| `recotem_watcher_unhandled_errors_total` | Counter | — |
| `recotem_metadata_lookup_errors_total` | Counter | `recipe` |
| `recotem_recipe_rescan_errors_total` | Counter | `recipe` |
| `recotem_bigquery_storage_fallback_total` | Counter | `reason` |
| `recotem_recipes_dir_scan_failures_total` | Counter | `error_class` |

The `status` label on `recotem_predict_total` takes values `ok`, `user_not_found`, `unavailable`, and `error`.

---

## OpenAPI documentation endpoints

Interactive documentation at `/docs` (Swagger UI), `/redoc`, and the raw schema at `/openapi.json` are available by default.

::: warning
When `RECOTEM_ENV` is set to `production`, `prod`, or `staging`, these three endpoints are **disabled**. Do not rely on them in production deployments.
:::

---

## Middleware

### TrustedHostMiddleware

`RECOTEM_ALLOWED_HOSTS` (default: `127.0.0.1,localhost`) controls the `Host` header allow-list. Requests with a `Host` header not in this list receive `400 Bad Request`. This applies to every endpoint including `/health`.

In Kubernetes, kubelet probes send `Host: localhost` by default — this is why `localhost` is always in the default allow-list. When exposing via Ingress, add the Ingress hostname explicitly (or use the Helm chart which derives it automatically from `ingress.hosts`).

### CORS

`RECOTEM_ALLOWED_ORIGINS` (default: empty = deny all) sets the CORS allow-list. When empty, all CORS preflight requests are denied. Provide a comma-separated list of origins to allow browser-based clients.

```yaml
RECOTEM_ALLOWED_ORIGINS: "https://app.example.com,https://admin.example.com"
```
