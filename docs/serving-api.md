---
title: "Serving API"
description: "Complete reference for the recotem serving API — all endpoints, authentication, request/response shapes, error codes, and middleware."
---

# Serving API

`recotem serve` exposes a FastAPI application over HTTP. All endpoints live under the `/v1` namespace. Custom verbs follow the [AIP-136](https://google.aip.dev/136) colon-verb convention — for example, `/v1/recipes/{name}:recommend`.

## Authentication

All endpoints except `GET /v1/health` require the `X-API-Key` request header carrying a plaintext API key.

Keys are configured via `RECOTEM_API_KEYS` as a comma-separated list of `<kid>:sha256:<hex64>` entries. The server verifies the submitted plaintext against a scrypt-derived hash stored in the entry (scrypt parameters: N=2, r=8, p=1, salt=`recotem.api-key.v1`). Key length must be between 32 and 256 characters.

Generate a valid API key with:

```bash
recotem keygen --type api
```

This produces a 43-character base64url string ready to use as the plaintext key. The corresponding `sha256:<hex64>` digest is printed for placement in `RECOTEM_API_KEYS`.

When `RECOTEM_API_KEYS` is empty and `--insecure-no-auth` is not set:

- The server forces `127.0.0.1` as the bind host regardless of `RECOTEM_HOST`.
- All requests are accepted without a key (the client is tagged as `kid=anonymous` in logs).

::: warning
Trailing or leading whitespace in the `X-API-Key` header is treated as part of the key and will not match. Trim values client-side before sending.
:::

## Common Headers

| Header | Direction | Description |
|---|---|---|
| `X-API-Key` | Request | Authentication token (plaintext). Required on all endpoints except `GET /v1/health`. |
| `X-Request-ID` | Request / Response | Client-supplied request identifier. Must match `^[A-Za-z0-9_-]{1,128}$`. Values that do not match, or absent values, cause the server to generate a fresh 12-hex identifier. The value actually used is echoed in the response. |
| `X-Recotem-Model-Version` | Response | The model version hash (`sha256:<64-hex>`) of the recipe that served the request. Present on all recommendation responses. Mirrors the `model_version` field in the response body. |
| `X-Recotem-Items-Degraded` | Response | Single-recommendation endpoints only. Set to the total count of items whose metadata join produced a fallback or was dropped. Absent when the response is fully clean. Not sent on batch endpoints. |

## Recipe Name Format

Recipe names used as path parameters must match `^[A-Za-z0-9_-]{1,64}$`. Paths with a name that does not match are rejected by the router — depending on how the URL parses, the response is either `404 Not Found` or `422 Unprocessable Entity`.

## Endpoints

### Recommendation

#### POST /v1/recipes/{name}:recommend

Get top-K recommendations for a single user.

**Authentication:** Required (`X-API-Key`).

**Path parameter:** `name` — recipe name matching `^[A-Za-z0-9_-]{1,64}$`.

**Request body** (`extra` fields are forbidden):

| Field | Type | Constraints | Default | Description |
|---|---|---|---|---|
| `user_id` | string | required, 1–256 chars | — | User identifier as seen in training data. |
| `limit` | integer | 1–1000 | `10` | Maximum number of items to return. |
| `exclude_items` | string[] \| null | optional, ≤1000 items | null | Item IDs to exclude from the result. |

```json
{
  "user_id": "u1",
  "limit": 10,
  "exclude_items": ["item-99"]
}
```

**Response body (200 OK):**

```json
{
  "request_id": "a1b2c3d4e5f6",
  "recipe": "purchase_log",
  "model_version": "sha256:a3f2...e91d",
  "items": [
    {"item_id": "item-42", "score": 0.91, "title": "Example Item", "category": "books"},
    {"item_id": "item-17", "score": 0.84}
  ]
}
```

Items are ordered by descending `score`. The `score` field is always a finite number (NaN and Inf are rejected internally). Each item always contains `item_id` and `score`; additional fields are joined from the item metadata configured in the recipe's `item_metadata` block. Because `RecommendItem` permits extra fields, metadata-derived fields appear alongside `item_id` and `score`.

**Status codes:**

| Code | Condition | Error code |
|---|---|---|
| 200 | Success | — |
| 401 | Missing `X-API-Key` | `MISSING_API_KEY` |
| 401 | Key does not match any entry | `INVALID_API_KEY` |
| 404 | `user_id` was not seen during training | `UNKNOWN_USER` |
| 422 | Request body failed schema validation | `VALIDATION_ERROR` |
| 503 | Recipe is not loaded | `RECIPE_UNAVAILABLE` |

::: tip UNKNOWN_USER is not a server error
A 404 for an unknown user is expected for new users not seen during training. Handle it in your application layer — for example, fall back to popularity-based recommendations.
:::

**curl example:**

```bash
curl -s -X POST http://localhost:8080/v1/recipes/purchase_log:recommend \
  -H "X-API-Key: <plaintext>" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "u1", "limit": 10}' | jq .
```

---

#### POST /v1/recipes/{name}:recommend-related

Get items related to one or more seed items.

**Authentication:** Required (`X-API-Key`).

**Request body:**

| Field | Type | Constraints | Default | Description |
|---|---|---|---|---|
| `seed_items` | string[] | required, 1–100 items | — | Item IDs used as seeds. |
| `limit` | integer | 1–1000 | `10` | Maximum number of items to return. |
| `exclude_items` | string[] \| null | optional | null | Item IDs to exclude from the result. |

```json
{
  "seed_items": ["item-42", "item-17"],
  "limit": 10
}
```

**Response body (200 OK):** Same shape as `:recommend`.

**Status codes:**

| Code | Condition | Error code |
|---|---|---|
| 200 | Success | — |
| 401 | Authentication failure | `MISSING_API_KEY` / `INVALID_API_KEY` |
| 404 | All seed items are unknown to the model | `UNKNOWN_SEED_ITEMS` |
| 404 | Seeds are known but no candidates survive ranking | `NO_CANDIDATES` |
| 422 | Schema validation failure | `VALIDATION_ERROR` |
| 503 | Recipe is not loaded | `RECIPE_UNAVAILABLE` |

**curl example:**

```bash
curl -s -X POST http://localhost:8080/v1/recipes/purchase_log:recommend-related \
  -H "X-API-Key: <plaintext>" \
  -H "Content-Type: application/json" \
  -d '{"seed_items": ["item-42"], "limit": 5}' | jq .
```

---

#### POST /v1/recipes/{name}:batch-recommend

Get recommendations for multiple users in a single request. Uses an Algolia-style batch envelope.

**Authentication:** Required (`X-API-Key`).

**Request body:**

| Field | Type | Constraints | Default | Description |
|---|---|---|---|---|
| `requests` | RecommendRequest[] | 1–256 items | — | Per-user recommendation requests. Each element has the same shape as the `:recommend` body. |
| `include_metadata` | boolean | — | `false` | When `false`, metadata-joined fields are omitted from `items` for bulk-performance reasons. Set to `true` to get the same item shape as the single-user endpoint. |

```json
{
  "requests": [
    {"user_id": "u1", "limit": 5},
    {"user_id": "u2", "limit": 5, "exclude_items": ["item-99"]}
  ],
  "include_metadata": false
}
```

**Response body (200 OK):**

```json
{
  "request_id": "a1b2c3d4e5f6",
  "recipe": "purchase_log",
  "model_version": "sha256:a3f2...e91d",
  "results": [
    {
      "index": 0,
      "status": "ok",
      "items": [{"item_id": "item-42", "score": 0.91}]
    },
    {
      "index": 1,
      "status": "error",
      "error": {"code": "UNKNOWN_USER", "message": "user not seen during training"}
    }
  ]
}
```

`results` preserves the original order of `requests` via the `index` field. A failed element carries `status: "error"` and an `error` object; other elements in the same batch are still processed.

**Batch-specific rules:**

- The `requests` array must contain 1–256 elements. Arrays outside this range return a `422` for the entire request.
- The sum of all `requests[].limit` values must not exceed **5000**. Elements that push the sum over the limit receive a per-element `VALIDATION_ERROR` result; later elements continue to be processed.
- An individual element with a schema error does not fail the whole batch. The element receives a per-element `VALIDATION_ERROR` result and the overall HTTP response remains `200`.
- `X-Recotem-Items-Degraded` is not sent on batch responses.
- `503` is returned only when the recipe itself is unavailable (not loaded). Per-element errors such as `UNKNOWN_USER` do not affect the HTTP status code.

**curl example:**

```bash
curl -s -X POST http://localhost:8080/v1/recipes/purchase_log:batch-recommend \
  -H "X-API-Key: <plaintext>" \
  -H "Content-Type: application/json" \
  -d '{
    "requests": [
      {"user_id": "u1", "limit": 5},
      {"user_id": "u2", "limit": 5}
    ],
    "include_metadata": false
  }' | jq .
```

---

#### POST /v1/recipes/{name}:batch-recommend-related

Get related-item recommendations for multiple seeds in a single request.

**Authentication:** Required (`X-API-Key`).

**Request body:** Same envelope as `:batch-recommend`, with each element following the `:recommend-related` body shape.

```json
{
  "requests": [
    {"seed_items": ["item-42"], "limit": 5},
    {"seed_items": ["item-17", "item-8"], "limit": 10}
  ],
  "include_metadata": false
}
```

**Response body (200 OK):** Same envelope as `:batch-recommend`.

**Batch rules:** Identical to `:batch-recommend` above.

**curl example:**

```bash
curl -s -X POST http://localhost:8080/v1/recipes/purchase_log:batch-recommend-related \
  -H "X-API-Key: <plaintext>" \
  -H "Content-Type: application/json" \
  -d '{
    "requests": [
      {"seed_items": ["item-42"], "limit": 5}
    ]
  }' | jq .
```

---

### Recipe Discovery

#### GET /v1/recipes

List all currently loaded recipes.

**Authentication:** Required (`X-API-Key`).

Stub entries for recipes whose artifact or YAML failed to load at startup are excluded — they appear in `GET /v1/health/details` instead.

**Response body (200 OK):**

```json
{
  "recipes": [
    {
      "name": "purchase_log",
      "model_version": "sha256:a3f2...e91d",
      "loaded_at": "2026-05-21T00:00:00Z",
      "supported_verbs": [
        "recommend",
        "recommend-related",
        "batch-recommend",
        "batch-recommend-related"
      ],
      "kind": "user-item"
    }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `name` | string | Recipe name (stem of the recipe YAML file). |
| `model_version` | string | `sha256:<64-hex>` digest of the artifact. |
| `loaded_at` | string (ISO 8601) | Timestamp when the artifact was loaded into memory. |
| `supported_verbs` | string[] | Colon-verbs this recipe supports. Depends on the recipe `kind`. |
| `kind` | `"user-item"` \| `"item-item"` | Whether the model produces user-to-item or item-to-item recommendations. `"item-item"` recipes do not support `recommend` or `batch-recommend`. |

**curl example:**

```bash
curl -s http://localhost:8080/v1/recipes \
  -H "X-API-Key: <plaintext>" | jq .
```

---

#### GET /v1/recipes/{name}

Detailed metadata for a single loaded recipe.

**Authentication:** Required (`X-API-Key`).

**Response body (200 OK):**

All fields from `GET /v1/recipes` plus:

| Field | Type | Description |
|---|---|---|
| `config_digest` | string \| null | `sha256:<hex>` of the recipe YAML, or null if unavailable. |
| `algorithms` | string[] | All algorithm classes evaluated during tuning. |
| `best_algorithm` | string | Algorithm class selected as best. |
| `best_class` | string \| null | Fully qualified class name of the best algorithm. |
| `best_params` | object \| null | Hyperparameters of the best algorithm. |
| `best_score` | number \| null | Validation score of the best model. NaN and Inf are normalized to null. |
| `metric` | `"ndcg"` \| `"map"` \| `"recall"` \| `"hit"` \| null | Evaluation metric used during tuning. |
| `cutoff` | integer \| null | Cutoff K used when computing the offline evaluation metric during tuning. This is unrelated to the per-request `limit` — it only describes how the recipe was scored at training time. |
| `tuning` | object \| null | Tuning metadata (`tried_algorithms`, `n_trials`, `n_completed`). |
| `data_stats` | object \| null | Training data statistics (`n_rows`, `n_users`, `n_items`). |
| `recotem_version` | string \| null | Version of recotem that trained this artifact. |
| `irspack_version` | string \| null | Version of irspack used during training. |
| `recipe_hash` | string \| null | 64-character lowercase hex digest of the recipe configuration at training time (no `sha256:` prefix — distinct from `config_digest`). |
| `trained_at` | string (ISO 8601) \| null | Timestamp when training completed. |

Optional fields above are `null` for older artifacts that did not record them.

**Status codes:**

| Code | Condition | Error code |
|---|---|---|
| 200 | Recipe is loaded | — |
| 404 | Recipe name does not exist in the registry | `RECIPE_NOT_FOUND` |
| 503 | Recipe exists but is not loaded | `RECIPE_UNAVAILABLE` |

**curl example:**

```bash
curl -s http://localhost:8080/v1/recipes/purchase_log \
  -H "X-API-Key: <plaintext>" | jq .
```

---

### Health and Metrics

#### GET /v1/health

Overall liveness and readiness status. Suitable for Kubernetes liveness and readiness probes.

**Authentication:** None (unauthenticated).

**Response body:**

```json
{"status": "ok", "total": 3, "loaded": 3}
```

| Field | Type | Description |
|---|---|---|
| `status` | `"ok"` \| `"degraded"` | `"ok"` when every configured recipe is loaded. `"degraded"` when any recipe is unloaded. When `total == 0`, the status is always `"ok"`. |
| `total` | integer | Total number of recipe entries in the registry. |
| `loaded` | integer | Number of recipes successfully loaded and ready to serve. |

**Status codes:**

| Code | Condition |
|---|---|
| 200 | All recipes are loaded. |
| 503 | One or more recipes are not loaded. |

::: tip Kubernetes readiness probes
A `503` response removes the pod from the Service endpoints. This is intentional — a pod where every recommendation request would return `503` should not receive traffic. Use `GET /v1/health` for both readiness and liveness probes.
:::

**curl example:**

```bash
curl -s http://localhost:8080/v1/health | jq .
```

---

#### GET /v1/health/details

Per-recipe health detail including load errors and artifact identifiers.

**Authentication:** Required (`X-API-Key`).

Per-recipe detail is behind authentication because it includes artifact key identifiers (`kid`) that should not be publicly discoverable. Use `GET /v1/health` for unauthenticated probe-safe status.

**Response body:**

```json
{
  "status": "ok",
  "recipes": {
    "purchase_log": {
      "loaded": true,
      "trained_at": "2026-05-21T00:00:00Z",
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

Every recipe in the registry appears here, including stubs for recipes that failed to load at startup. Optional fields (`trained_at`, `best_class`, `kid`, `error`) are present only when their underlying value is set.

**Status codes:** Same as `GET /v1/health` — `503` when any recipe carries `loaded: false` or an `error` field.

**curl example:**

```bash
curl -s http://localhost:8080/v1/health/details \
  -H "X-API-Key: <plaintext>" | jq .
```

---

#### GET /v1/metrics

Prometheus metrics exposition (opt-in).

**Authentication:** Required (`X-API-Key`).

**Availability:** This route is registered only when both conditions are met:

1. `RECOTEM_METRICS_ENABLED` is set to a truthy value (`1`, `true`, `yes`, `on`).
2. The `recotem[metrics]` extra is installed (`pip install "recotem[metrics]"`).

This endpoint is excluded from the OpenAPI schema.

::: warning Prometheus scraper configuration
Unlike most Prometheus targets, `/v1/metrics` requires `X-API-Key`. Configure your scraper to send the header:

```yaml
# prometheus.yml scrape config (Prometheus 2.45+)
scrape_configs:
  - job_name: recotem
    metrics_path: /v1/metrics
    static_configs:
      - targets: ["localhost:8080"]
    http_headers:
      X-API-Key:
        values: ["<plaintext>"]
```
:::

**Available metrics:**

| Metric | Type | Labels |
|---|---|---|
| `recotem_v1_requests_total` | Counter | `recipe`, `verb`, `status` |
| `recotem_v1_request_latency_seconds` | Histogram | `recipe`, `verb` |
| `recotem_v1_batch_size` | Histogram | `recipe`, `verb` |
| `recotem_v1_batch_element_errors_total` | Counter | `recipe`, `verb`, `code` |
| `recotem_v1_metadata_degraded_items_total` | Counter | `recipe`, `verb`, `kind` |
| `recotem_v1_validation_errors_outside_verb_total` | Counter | — |
| `recotem_model_loaded` | Gauge | `recipe` |
| `recotem_artifact_load_failures_total` | Counter | `recipe`, `reason` |
| `recotem_active_recipes` | Gauge | — |
| `recotem_swap_total` | Counter | `recipe`, `result` |
| `recotem_artifact_stat_failures_total` | Counter | `recipe` |
| `recotem_watcher_unhandled_errors_total` | Counter | — |
| `recotem_metadata_index_build_errors_total` | Counter | `recipe` |
| `recotem_metadata_serialization_errors_total` | Counter | `recipe`, `verb` |
| `recotem_recipe_rescan_errors_total` | Counter | `recipe` |
| `recotem_recommender_layout_unexpected_total` | Counter | `recipe` |
| `recotem_watcher_state_divergence_total` | Counter | — |
| `recotem_bigquery_storage_fallback_total` | Counter | `reason` |
| `recotem_recipes_dir_scan_failures_total` | Counter | `error_class` |

The `verb` label takes values `recommend`, `recommend-related`, `batch-recommend`, `batch-recommend-related`. The `status` label on `recotem_v1_requests_total` takes values `ok`, `unknown_user`, `unknown_seed_items`, `no_candidates`, `unavailable`, `recipe_not_found`, `validation_error`, and `error`. The `reason` label on `recotem_artifact_load_failures_total` takes values `read`, `parse`, `hmac`, `header_json`, `deserialize`, `metadata`, `yaml`, `unexpected`, `dir_scan`, and `timeout`.

**curl example:**

```bash
curl -s http://localhost:8080/v1/metrics \
  -H "X-API-Key: <plaintext>"
```

---

## Error Format

All error responses use a flat JSON body with at minimum `detail` (human-readable) and `code` (machine-readable UPPER_SNAKE_CASE).

**Standard error body:**

```json
{"detail": "recipe purchase_log is not loaded", "code": "RECIPE_UNAVAILABLE"}
```

**Validation error body (422 only):** Includes a `request_id` and a structured `errors` array.

```json
{
  "request_id": "a1b2c3d4e5f6",
  "detail": "Request validation failed",
  "code": "VALIDATION_ERROR",
  "errors": [
    {"loc": ["body", "limit"], "msg": "ensure this value is less than or equal to 1000", "type": "value_error.number.not_le"}
  ]
}
```

**Internal error body (500 only):** Includes a `request_id` for correlation with server logs.

```json
{"detail": "internal error", "code": "INTERNAL_ERROR", "request_id": "a1b2c3d4e5f6"}
```

### Error Codes

| Code | HTTP | When |
|---|---|---|
| `RECIPE_UNAVAILABLE` | 503 | Recipe exists in the registry but its artifact is not loaded. |
| `RECIPE_NOT_FOUND` | 404 | Recipe name does not exist in the registry at all. |
| `UNKNOWN_USER` | 404 | `user_id` was not present in the training idmap. |
| `UNKNOWN_SEED_ITEMS` | 404 | All items in `seed_items` are unknown to the model. |
| `NO_CANDIDATES` | 404 | Seed items are known but no candidates survive the ranking stage. |
| `VALIDATION_ERROR` | 422 (HTTP) / per-element (batch) | Request or element body failed schema validation. |
| `MISSING_API_KEY` | 401 | `X-API-Key` header is absent. |
| `INVALID_API_KEY` | 401 | `X-API-Key` does not match any configured key. |
| `INTERNAL_ERROR` | 500 (HTTP) / per-element (batch) | Unhandled exception during request processing. |

---

## Middleware

### TrustedHostMiddleware

`RECOTEM_ALLOWED_HOSTS` (default: `127.0.0.1,localhost`) controls the `Host` header allow-list. Requests with a `Host` header not in this list receive `400 Bad Request`. This applies to every endpoint including `GET /v1/health`.

In Kubernetes, kubelet probes send `Host: localhost` by default — this is why `localhost` is always in the default allow-list. When exposing via Ingress, add the Ingress hostname to `RECOTEM_ALLOWED_HOSTS` explicitly.

### CORS

`RECOTEM_ALLOWED_ORIGINS` (default: empty = deny all) sets the CORS allow-list. When empty, all CORS preflight requests are denied. Provide a comma-separated list of origins to allow browser-based clients.

```yaml
RECOTEM_ALLOWED_ORIGINS: "https://app.example.com,https://admin.example.com"
```

---

## OpenAPI Documentation

Interactive documentation is available at `/docs` (Swagger UI) and `/redoc`. The raw schema is at `/openapi.json`.

::: warning Development environments only
These three endpoints are available only when `RECOTEM_ENV` is set to `development`, `dev`, or `test`. They are disabled in all other environments. Do not rely on them in production deployments.
:::
