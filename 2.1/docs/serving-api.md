---
title: "Serving API"
description: "Complete reference for the recotem serving API — all endpoints, authentication, request/response shapes, error codes, and middleware."
---

# Serving API

`recotem serve` exposes a FastAPI application over HTTP. All endpoints live under the `/v1` namespace. Custom verbs follow the [AIP-136](https://google.aip.dev/136) colon-verb convention — for example, `/v1/recipes/{name}:recommend`.

## Authentication

All endpoints except the three unauthenticated probes (`GET /v1/health`, `GET /v1/health/live`, `GET /v1/health/ready`) require the `X-API-Key` request header carrying a plaintext API key.

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
| `X-API-Key` | Request | Authentication token (plaintext). Required on all endpoints except the three probes `GET /v1/health`, `GET /v1/health/live`, and `GET /v1/health/ready`. |
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
| `user_features` | object \| null | optional, ≤64 keys; keys 1–256 chars; string values ≤8192 chars | null | Raw feature values keyed by the recipe's `features.user` column names. Only meaningful against a model trained with a [`features:`](./recipe-reference#features) block. See [Feature-aware cold start](#feature-aware-cold-start). |

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
| 400 | `user_features` supplied but the model has no matching feature state | `FEATURES_NOT_SUPPORTED` |
| 400 | A `numerical` feature value standardizes to a magnitude the cold-start solver cannot use | `FEATURE_VALUE_UNUSABLE` |
| 401 | Missing `X-API-Key` | `MISSING_API_KEY` |
| 401 | Key does not match any entry | `INVALID_API_KEY` |
| 404 | `user_id` was not seen during training (and no usable `user_features` were supplied) | `UNKNOWN_USER` |
| 413 | Request body exceeds `RECOTEM_MAX_BODY_BYTES` | `PAYLOAD_TOO_LARGE` |
| 422 | Request body failed schema validation | `VALIDATION_ERROR` |
| 503 | Recipe is not loaded | `RECIPE_UNAVAILABLE` |

::: tip UNKNOWN_USER is not a server error
A 404 for an unknown user is expected for new users not seen during training. Handle it in your application layer — for example, fall back to popularity-based recommendations. On a model trained with a [`features:`](./recipe-reference#features) block you can instead supply `user_features` and get a real recommendation for that new user; see [Feature-aware cold start](#feature-aware-cold-start).
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
| `user_features` | object \| null | optional, ≤64 keys; keys 1–256 chars; string values ≤8192 chars | null | Raw feature values keyed by the recipe's `features.user` column names. Adds a profile prior to the seed-history solve. See [Feature-aware cold start](#feature-aware-cold-start). |
| `item_features` | object[string, object] \| null | optional, ≤100 outer keys; each value ≤64 keys | null | Raw feature values for seed items absent from training, keyed by seed item id. See [Feature-aware cold start](#feature-aware-cold-start). |

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
| 400 | `user_features` / `item_features` supplied but the model has no matching feature state | `FEATURES_NOT_SUPPORTED` |
| 400 | A `numerical` feature value standardizes to a magnitude the cold-start solver cannot use | `FEATURE_VALUE_UNUSABLE` |
| 401 | Authentication failure | `MISSING_API_KEY` / `INVALID_API_KEY` |
| 404 | All seed items are unknown to the model | `UNKNOWN_SEED_ITEMS` |
| 404 | Seeds are known but no candidates survive ranking | `NO_CANDIDATES` |
| 413 | Request body exceeds `RECOTEM_MAX_BODY_BYTES` | `PAYLOAD_TOO_LARGE` |
| 422 | Schema validation failure | `VALIDATION_ERROR` |
| 501 | The recipe's trained algorithm cannot score a synthetic user built from `seed_items` | `RELATED_NOT_SUPPORTED` |
| 503 | Recipe is not loaded | `RECIPE_UNAVAILABLE` |

::: warning A BPRFM recipe cannot answer the related verbs
`BPRFMRecommender` is the only supported algorithm that does not implement `get_score_cold_user`, which is what this verb needs to score the synthetic user built from `seed_items`. A recipe whose search winner is BPRFM answers **`501 RELATED_NOT_SUPPORTED`** here, and a per-element `RELATED_NOT_SUPPORTED` inside a `200` on [`:batch-recommend-related`](#post-v1-recipes-name-batch-recommend-related). `:recommend` and `:batch-recommend` are unaffected:

```console
$ curl -s -w '\nHTTP=%{http_code}\n' -X POST ".../v1/recipes/bprfm_demo:recommend-related" \
    -H "X-API-Key: <plaintext>" -H "Content-Type: application/json" \
    -d '{"seed_items":["291"],"limit":3}'
{"detail":"BPRFMRecommender cannot score a synthetic user built from seed_items, so this
recipe supports :recommend and :batch-recommend only. Retrain the recipe with an algorithm
that does (every supported algorithm except BPRFM) if the related verbs are required.",
 "code":"RELATED_NOT_SUPPORTED"}
HTTP=501
```

Because the algorithm is chosen by the Optuna search, listing `BPRFM` alongside others in `training.algorithms` means the verb's availability depends on which one wins. If your application needs related items, do not list `BPRFM`; if it wins anyway, `recotem inspect` shows `best_class` before you deploy. Search `503` and `501` differently in client retry logic: `503` clears when the artifact loads, `501` never clears without a retrain.
:::

`NO_CANDIDATES` is raised identically on every branch of this verb — the all-seeds-known path and both feature-aware cold-start branches — so a client may branch on HTTP status regardless of which path served the request.

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
| `requests` | RecommendRequest[] | 1–256 items | — | Per-user recommendation requests. Each element has the same shape as the `:recommend` body, including the optional `user_features` cold-start mapping. |
| `include_metadata` | boolean | — | `false` | When `false`, metadata-joined fields are omitted from `items` for bulk-performance reasons. Set to `true` to get the same item shape as the single-user endpoint. |

Each element accepts `user_features` exactly as the single `:recommend` endpoint does (see [Feature-aware cold start](#feature-aware-cold-start)). An element whose model has no matching feature state surfaces as `status: "error"` with `code: "FEATURES_NOT_SUPPORTED"` rather than failing the whole batch. Batching is also the recommended path for bulk cold start — it amortizes the per-request solve from 300–500 µs to 8–12 µs per user.

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
- An individual element with a schema error does not fail the whole batch. The element receives a per-element `VALIDATION_ERROR` result and the overall HTTP response remains `200`. A cold-start key-length, value-type, or value-length violation surfaces the same way, rather than failing the whole batch with `422`.
- `X-Recotem-Items-Degraded` is not sent on batch responses.
- `503` is returned only when the recipe itself is unavailable (not loaded). Per-element errors such as `UNKNOWN_USER` do not affect the HTTP status code.
- The whole request body is still bounded by `RECOTEM_MAX_BODY_BYTES` (default 128 MiB): a body over the cap is rejected with `413 PAYLOAD_TOO_LARGE` before the JSON is parsed.

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

| Field | Type | Constraints | Default | Description |
|---|---|---|---|---|
| `requests` | RecommendRelatedRequest[] | 1–256 items | — | Per-seed related-item requests. Each element has the same shape as the `:recommend-related` body, including the optional `user_features` and `item_features` cold-start mappings. |
| `include_metadata` | boolean | — | `false` | When `false`, metadata-joined fields are omitted from `items`. Set to `true` to get the same item shape as the single-seed endpoint. |

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

**Batch rules:** Identical to `:batch-recommend` above, plus one extra aggregate cap.

::: warning Aggregate cold-seed solve cap: 512
This verb carries a *second* aggregate cap that `:batch-recommend` does not need. [Case C](#feature-aware-cold-start) runs one solve per cold seed, so the aggregate count of cold seeds — the `sum` over elements of the seeds named in that element's `item_features` — must not exceed **512**. An element that would push the running total over the cap surfaces as `status: "error"` with `code: "VALIDATION_ERROR"`, exactly like the aggregate-`limit` cap, and later elements continue to be processed.

The two caps guard different dimensions and neither subsumes the other: `sum(limit)` bounds response volume, while this bounds solver work. A batch of `limit: 1` elements sits at 2% of the aggregate-`limit` cap while demanding 25,600 solves. The count is taken from the request alone — a seed named in `item_features` counts even if it turns out to be a known item whose learned embedding is used instead — so the same body is always accepted or rejected identically, regardless of which model is loaded.

A single `:recommend-related` call cannot reach this cap: `seed_items` is capped at 100, so a maximal single request is 100 solves.
:::

Each element accepts `user_features` / `item_features` exactly as the single `:recommend-related` endpoint does, including the case A/B/C precedence rules. An element that produces no survivors surfaces as `status: "error"` with `code: "NO_CANDIDATES"`, on every branch.

On a recipe whose trained algorithm cannot score a synthetic user — BPRFM is the only one — **every** element surfaces as `status: "error"` with `code: "RELATED_NOT_SUPPORTED"` and the HTTP status stays `200`. The single-verb form returns `501` instead; see the warning under [`:recommend-related`](#post-v1-recipes-name-recommend-related).

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

Three unauthenticated probe endpoints answer three different questions. Point each Kubernetes probe at the one that matches it — see the table under [`GET /v1/health/ready`](#get-v1-health-ready).

#### GET /v1/health

"Is **every** configured recipe present?" — the strict, count-based gate. Use it for a `startupProbe`, not for liveness or readiness.

**Authentication:** None (unauthenticated).

**Response body:**

```json
{"status": "ok", "total": 3, "loaded": 3}
```

| Field | Type | Description |
|---|---|---|
| `status` | `"ok"` \| `"degraded"` | `"ok"` when every recipe counted in `total` is loaded. `"degraded"` when any of them is unloaded. When `total == 0`, the status is always `"ok"`. |
| `total` | integer | Number of recipe entries in the registry, **excluding** files that could not be parsed at all. |
| `loaded` | integer | Number of recipes successfully loaded and ready to serve. |
| `skipped` | integer | Number of recipe files that could not be parsed at all (YAML syntax error, schema violation). **Present only when non-zero.** Excluded from `total` and `loaded`: such a file declares no recipe, so it never makes the status `"degraded"`. See [Operations — Unparseable recipe files](./operations#unparseable-recipe-files). |

**Status codes:**

| Code | Condition |
|---|---|
| 200 | All recipes are loaded. A non-zero `skipped` count does not change this. |
| 503 | One or more recipes are not loaded. |

::: warning Do not point liveness or readiness at this endpoint
`total` counts recipes, not loadable models, so **one recipe whose artifact has not been trained yet turns this endpoint `503` for the whole process** — while every other recipe keeps answering `200`:

```console
$ curl -s -w ' HTTP=%{http_code}\n' localhost:8080/v1/health
{"status":"degraded","total":2,"loaded":1} HTTP=503

$ curl -s -w '\nHTTP=%{http_code}\n' -X POST \
    "localhost:8080/v1/recipes/purchase_log:recommend" \
    -H "X-API-Key: <plaintext>" -H "Content-Type: application/json" \
    -d '{"user_id":"1","limit":3}'
{"request_id":"c2bc70c2c907","recipe":"purchase_log", ... }
HTTP=200
```

On a `readinessProbe` that removes every replica from the Service — they all read the same recipes directory, so they all fail together. On a `livenessProbe` it is worse: the kubelet restarts the pod, the replacement reads the same directory, fails the same way, and CrashLoopBackOffs — dropping the models that *were* loaded on every restart. A restart cannot conjure a missing artifact. Use [`/v1/health/ready`](#get-v1-health-ready) and [`/v1/health/live`](#get-v1-health-live) for those two probes and keep `/v1/health` for the `startupProbe`, where the strict gate is what you want.

The two recipe failure modes differ here. An **unparseable recipe file** returns `200` with a `skipped` count and the pod keeps its traffic; a **valid recipe whose artifact cannot load** returns `503 degraded`. Alert on `skipped` as a warning, not as a page.
:::

**curl example:**

```bash
curl -s http://localhost:8080/v1/health | jq .
```

---

#### GET /v1/health/live

"Would a restart help?" — the liveness probe. Always `200` while the process can answer; it never reads artifact state and never takes the registry lock, so a probe cannot block behind a hot-swap and report a healthy process as dead.

**Authentication:** None (unauthenticated).

**Response body:**

```json
{"status": "alive"}
```

**Status codes:**

| Code | Condition |
|---|---|
| 200 | The process is answering HTTP. |

There is no failure response: for a missing or unloadable artifact the answer to "would a restart help?" is always no.

**curl example:**

```bash
curl -s http://localhost:8080/v1/health/live | jq .
```

---

#### GET /v1/health/ready

"Should the Service send traffic to this replica?" — the readiness probe. `200` when at least one recipe is loaded, `503` when none is.

**Authentication:** None (unauthenticated).

**Response body:**

```json
{"status": "ready", "total": 3, "loaded": 3}
```

Same fields as `GET /v1/health`, with `status` taking `"ready"` / `"unready"` instead of `"ok"` / `"degraded"`. `skipped` appears only when non-zero.

**Status codes:**

| Code | Condition |
|---|---|
| 200 | At least one recipe is loaded, or the registry is empty (`total == 0`). |
| 503 | `total > 0` and nothing is loaded — a cold fleet that `train` has never fed. |

A replica holding 13 of 14 models can serve 13 of them; taking it out of the Service serves nobody. A cold fleet still fails, which is what keeps the first-install guarantee: `serve` does not enter the Service before `train` has produced something.

**curl example:**

```bash
curl -s http://localhost:8080/v1/health/ready | jq .
```

::: tip Which probe gets which endpoint
| Probe | Endpoint | Question it answers |
|---|---|---|
| `startupProbe` | `/v1/health` | Is every configured recipe present? (strict first-start gate) |
| `readinessProbe` | `/v1/health/ready` | Can this replica serve anything at all? |
| `livenessProbe` | `/v1/health/live` | Is the process still answering? |

This is what the bundled Helm chart renders and what the [Kubernetes deployment page](./deployment/kubernetes#deployment-serve) shows. All three send `Host: localhost`, so `RECOTEM_ALLOWED_HOSTS` must include it.
:::

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
| `recotem_v1_feature_unknown_value_total` | Counter | `recipe`, `side`, `column` |
| `recotem_v1_feature_unknown_column_total` | Counter | `recipe`, `side` |
| `recotem_v1_cold_start_requests_total` | Counter | `recipe`, `case` |
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

The `verb` label takes values `recommend`, `recommend-related`, `batch-recommend`, `batch-recommend-related`. The `status` label on `recotem_v1_requests_total` takes values `ok`, `unknown_user`, `unknown_seed_items`, `no_candidates`, `unavailable`, `recipe_not_found`, `validation_error`, `features_not_supported`, `feature_value_unusable`, and `error`. The `reason` label on `recotem_artifact_load_failures_total` takes values `read`, `parse`, `hmac`, `header_json`, `deserialize`, `metadata`, `yaml`, `unexpected`, `dir_scan`, `timeout`, `version_skew`, `feature_version`, and `feature_state`. The `case` label on `recotem_v1_cold_start_requests_total` takes values `features_only` (case A), `features_and_history` (case B), and `cold_seeds` (case C).

::: warning `status="error"` is server faults only
`features_not_supported` and `feature_value_unusable` are client-caused outcomes and carry their own `status` labels precisely so a malformed client cannot page on-call. Alert on `status="error"` exactly — never on `status!="ok"`.
:::

**curl example:**

```bash
curl -s http://localhost:8080/v1/metrics \
  -H "X-API-Key: <plaintext>"
```

---

## Feature-aware cold start

`user_features` and `item_features` are only meaningful against a model trained with a [`features:`](./recipe-reference#features) block. They are accepted (and validated) on every model, but a model with no matching feature state — or whose search winner is not feature-capable — responds `400 FEATURES_NOT_SUPPORTED` rather than silently ignoring the field or guessing.

Whether a given artifact can serve these cases is readable up front, without sending a request: `recotem inspect` prints `features.active`, which is `true` only when the search winner can actually consume the encoder state. An artifact with no `features` key at all, or with `"active": false`, will answer `FEATURES_NOT_SUPPORTED` — see [Recipe Reference — What the artifact header records](./recipe-reference#what-the-artifact-header-records).

### The three cases

| Case | Verb | Trigger | What it does |
|---|---|---|---|
| A — unknown user, features only | `:recommend` | `user_id` unknown, `user_features` present | Scores every known item against the profile alone (no interaction history exists yet for this user). |
| B — unknown user, features + ad-hoc history | `:recommend-related` | `user_features` present | Runs the same seed-history solve as the pre-existing path, with the profile added as a joint prior. This is a genuine joint solve, not either/or: it correlates with neither a features-only nor a history-only score alone. |
| C — unknown seed item(s) | `:recommend-related` | one or more `seed_items` absent from training, and a matching entry in `item_features` | Computes each cold seed's embedding from its features, averages it with the known seeds' learned embeddings, and scores as item-item similarity. |

If a request supplies both a cold seed's `item_features` **and** `user_features` on `:recommend-related`, **case C wins**: a cold seed has no row in the seed-history matrix that case B's solve uses, so running case B alone would silently drop that seed's contribution. Case C is the only path that can actually use a cold seed's features.

Each case increments `recotem_v1_cold_start_requests_total` under a `case` label of `features_only`, `features_and_history`, or `cold_seeds` respectively.

::: tip A known `user_id` with `user_features` supplied is not an error
The learned embedding from that user's real interaction history strictly dominates a profile prior, so the server always prefers it and simply **ignores** the supplied `user_features` — it does not reject the request. This lets a client always send the user's profile on every request without needing to know in advance whether the user is new or returning.
:::

### An undeclared feature key is silently ignored

A feature key that names no declared column is **not** an error. The encode is driven from the model's *declared* `features:` columns, so a key in `user_features` / `item_features` that matches no declared column on that side is never read. The request returns `200` with no error field and nothing in the body marking the key as rejected.

The only server-side signal is the `recotem_v1_feature_unknown_column_total` metric, labelled by recipe and **side only — never by the key name** — and incremented once per side per request that carried at least one such key. This is distinct from an unknown *value* in a *declared* column (below), which also returns `200` but is counted separately by `recotem_v1_feature_unknown_value_total`.

::: danger Clients must not rely on the API to validate feature keys
A mapping in which *every* key is mistyped (or is aimed at the wrong side) encodes to the bias column alone and comes back with **population-prior results** — the same output an empty `user_features` would produce, and indistinguishable from it in the response. A silently-ignored key is byte-for-byte identical, in the response, to a correct request that happened to add no signal.
:::

### Unknown feature values degrade, they do not fail the request

What "degrade" means, and whether `recotem_v1_feature_unknown_value_total` actually catches it, differs by encoding:

- `categorical` — a value absent from the training vocabulary encodes to an all-zero segment for that column, and the counter increments.
- `multi_label` — each token is looked up independently: known tokens are retained (each contributing exactly one `1.0` to its dimension, even if the token is repeated in the input), unknown tokens are dropped. The counter increments whenever **any** supplied token misses the vocabulary, even if other tokens in the same value are known. A mixed value such as `"Action|Thrller"` sets the bit for the known token, drops `Thrller`, and still increments the counter — a partial typo is caught, not silently absorbed.
- `numerical` — a **missing** value (absent, `null`, or `NaN`) or a value that fails to parse as a number at all contributes nothing to the row, equivalent to encoding the standardized mean (`0`), and does **not** increment the counter. A value that DOES parse as a number but is **non-finite** (`Infinity` / `-Infinity`, or a `NaN` reached via a string like `"nan"`) also contributes nothing to the row, but this case **does** increment the counter: it is a real, present value the server could not use, not an absent one.

::: warning Not a general typo detector for `numerical` columns
A **missing or unparseable** `numerical` value still degrades the recommendation with no signal at all — only the non-finite case above is covered. `categorical` and `multi_label` are both reliably covered.
:::

`multi_label` is multi-**hot**, not a count vector: `"rock|pop|rock"` contributes `1.0` to the `rock` dimension, not `2.0` — duplicate tokens in one value are deduplicated before encoding, both at training time and for a cold-start request.

### Large numerical values: a wide silent-degrade band, and an extreme tail that 400s

Unlike the missing/unparseable case above, a `numerical` value is standardized at serve time by dividing the raw request value by the column's *training* mean/std — a fit the request's own value was never part of. Nothing clamps how large the resulting magnitude may get, so behavior is **not** a clean two-way split between "normal" and "hard 400". An actual sweep against a column with training std ≈ 0.425 found:

| Value | Result |
|---|---|
| `0.3` | `200`, small, normal-looking score |
| `100` | `200`, but the score is already visibly degenerate (order alone, no longer proportional to the profile) |
| `1e6` – `1e18` | `200`, score grows without bound (into the hundreds of millions and beyond) as the value grows |
| ~`1e19`+ | `400 FEATURE_VALUE_UNUSABLE` — only here does irspack's per-request cold-start solver itself give up |

::: danger Roughly `1e2` through `1e18` is a silent degrade
In that band the response is `200` with an unbounded, effectively meaningless score and a fixed/degenerate ranking — and none of these finite values touch `recotem_v1_feature_unknown_value_total` (that counter fires for a `numerical` value only when it is non-finite), so nothing server-side signals that this happened either.

The 400 only fires once the standardized magnitude is large enough to make the underlying conjugate-gradient solve singular. **The exact crossover is not a fixed constant** — it depends on the column's training std and the BLAS implementation solving the system, so do not hard-code a boundary value (e.g. `1e22`) as a contract.
:::

The 400's `detail` message describes the **standardized** value, not the client's raw one — because the raw value need not be extreme. A column whose training std is small enough can make an ordinary raw value like `10000` standardize to a magnitude that breaks the solver, exactly like `1e22` does against a normal-sized std. The `detail` string therefore never claims the supplied value itself was extreme; it says the resulting *standardized* value was numerically unusable for this model's cold-start scoring, which is true regardless of which side (raw magnitude vs. tiny std) produced it.

A near-constant column is a special case of a small std, not a separate bug — and training floors the most common cause of it. `build_encoder_state` floors a numerical column's training-time std to zero whenever it is no larger than `1e-8 × max(abs(mean), 1.0)` — tight enough to preserve real, intentional small variance while absorbing realistic floating-point rounding noise. A column caught by this floor never reaches the standardization divide at all: it degrades exactly like a missing value (logged once as `feature_zero_variance_column`), never a 400. This does not eliminate the phenomenon in general — a column with genuine (not rounding-noise) small variance just above the floor still standardizes an ordinary value to an unusable magnitude by the same mechanism as the sweep above.

Clamping the standardized magnitude before it reaches the solver — which would close the silent-degrade band — was deliberately deferred, not overlooked. Picking a clamp bound (how many training standard deviations is "too many") is a modelling decision that changes what every downstream consumer of the same encoding sees, including training, not a bugfix to the 400 path.

Training is unaffected either way: the same value flowing through training-time encoding is untouched by this guard, which only wraps the serve-time cold-start solve. Training has its own, much stronger bound — a numerical column's training-time mean/std are computed from the same values being standardized, so an outlier inflates the very std it is divided by. Serve-time has no such self-bound, because the request's value is standardized against a std fit without it.

### Length and size bounds on cold-start fields

A cold-start feature mapping is bounded on three axes, each rejected before the model is consulted:

| Axis | Bound | Over the bound |
|---|---|---|
| Key count | ≤ **64 keys** per `user_features` / `item_features` mapping. `item_features` additionally caps its outer seed-id keys at **100**. | `422 VALIDATION_ERROR` |
| Key length | Each feature-dict key (a `user_features` column name, an `item_features` outer seed id, or a nested per-seed feature key) must be **1–256 characters**. | `422`; the error reports only the offending length, never the key text |
| Value type | Each feature value must be a JSON **scalar** (string, number, boolean, or `null`). | `422` for an array or object |
| Value length | Each *string* feature value must be **≤ 8192 characters** (this bounds `multi_label` tokenization work). Non-string scalars are unaffected. | `422`; the error names the offending column but never echoes the value |

The value-type rule is not merely a size guard: values are encoded via `str(value)`, so an array would be matched against the training vocabulary as its Python repr and could never match anything — it was already a no-op, just an expensive one.

On the batch verbs a key-length, value-type, or value-length violation surfaces as a per-element `VALIDATION_ERROR` inside the `200` batch response rather than failing the whole batch.

Independently of these per-field caps, the **entire request body** is bounded by `RECOTEM_MAX_BODY_BYTES` (default **128 MiB**, clamped to `[1 MiB, 2 GiB]`). A body over that limit is rejected with `413 PAYLOAD_TOO_LARGE` **before** the JSON is parsed, so it applies to every POST endpoint regardless of which fields the body carries.

::: warning Feature values are personal data
`user_features` and `item_features` carry personal data by construction — an age band, a country, a device category. Raw feature values are never logged and never echoed back in a response body. See [Security — Request-side PII](./security#request-side-pii-user-features-item-features).
:::

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
| `FEATURES_NOT_SUPPORTED` | 400 (HTTP) / per-element (batch) | `user_features` / `item_features` were supplied to a model with no matching feature state — no `features:` block, or a search winner that cannot consume the encoder state (`features.active: false`). |
| `FEATURE_VALUE_UNUSABLE` | 400 | A `numerical` feature value standardizes to a magnitude that makes the per-request cold-start solve numerically singular. The message describes the *standardized* value, not the raw one. |
| `RELATED_NOT_SUPPORTED` | 501 (HTTP) / per-element (batch) | The recipe's trained algorithm cannot score a synthetic user built from `seed_items`, so the two related verbs are unavailable on it. `BPRFMRecommender` is the only supported algorithm in this position. Never clears on retry — it needs a retrain with a different algorithm. |
| `PAYLOAD_TOO_LARGE` | 413 | Request body exceeds `RECOTEM_MAX_BODY_BYTES` (default 128 MiB). Enforced before the JSON is parsed, on every POST endpoint. |
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
