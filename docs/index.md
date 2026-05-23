---
title: Architecture
---

# Architecture

Recotem is a recipe-driven recommender system: a single YAML file (the _recipe_) defines the data source, training configuration, and artifact destination. One recipe produces one trained model and a set of `/v1/recipes/{name}:<verb>` HTTP endpoints.

## System overview

```
  ┌─────────────────────────────────────┐
  │           Operator machine          │
  │                                     │
  │  recipe.yaml ──► recotem train      │
  │                       │             │
  │               fetch → tune → sign   │
  │                       │             │
  │               artifact.recotem      │
  └───────────────────────┼─────────────┘
                          │  (file copy / object storage)
  ┌───────────────────────▼─────────────┐
  │           Serving machine           │
  │                                     │
  │  recotem serve --recipes ./         │
  │       │                             │
  │       ├── HMAC verify               │
  │       ├── deserialize payload       │
  │       └── FastAPI /v1/recipes/{name}:recommend   │
  │                  │                               │
  │                  ▼                               │
  │          API client request                      │
  └─────────────────────────────────────┘
```

**Train and serve run on different machines and communicate only via signed artifact files.** The training process writes a binary artifact; the serving process reads it. There is no shared in-process state, no shared database, and no RPC between the two sides.

## The recipe

A recipe is the single source of truth for a model:

```
1 recipe YAML  →  1 trained artifact  →  /v1/recipes/{name}:recommend
                                         /v1/recipes/{name}:recommend-related
                                         /v1/recipes/{name}:batch-recommend
                                         /v1/recipes/{name}:batch-recommend-related
```

The recipe captures:
- **Where to get data** (`source` block — CSV, Parquet, BigQuery, SQL, GA4, or plugin)
- **How to map columns** (`schema` block — user ID, item ID, optional timestamp)
- **Data quality gates** (`cleansing` block — null-drop, dedup, minimum thresholds)
- **What to train** (`training` block — algorithms, Optuna budget, split scheme)
- **Where to write** (`output` block — path and versioning mode)

See [Recipe Reference](./recipe-reference) for the complete field reference.

## Artifact format

An artifact is a binary container with the layout:

```
magic | version | reserved | kid | hmac | header_json | payload
```

- **HMAC scope**: `kid_bytes || header_json || payload`. Modification of any byte in any of these sections fails HMAC verification.
- **Header JSON** carries `recipe_name`, `recipe_hash`, `best_class`, `best_params`, `best_score`, `metric`, `cutoff`, `tuning`, `data_stats`, `recotem_version`, `irspack_version`, and `trained_at`. Readable without deserialization via `recotem inspect`.
- **Payload** contains the serialized `IDMappedRecommender` (scipy sparse matrices + numpy arrays). HMAC is verified in full before a single byte of the payload is interpreted. The deserializer enforces an FQCN allow-list during unpickling as defence-in-depth.
- **Key ID (`kid`)** identifies which signing key produced the HMAC. The `KeyRing` (env: `RECOTEM_SIGNING_KEYS=kid1:hex,kid2:hex`) holds multiple keys, enabling zero-downtime key rotation.

::: warning Artifact integrity is non-negotiable
`recotem serve` refuses to load any artifact that fails HMAC verification. There is no flag to bypass this in production. `--dev-allow-unsigned` is gated behind `RECOTEM_ENV=development` and requires a companion flag (`--i-understand-this-loads-arbitrary-code`) precisely because it disables the only serialization trust boundary.
:::

## Trust boundaries

| Actor | What they control | Trust level |
|-------|------------------|-------------|
| Operator | Recipe YAML, signing keys, env vars, `RECOTEM_SIGNING_KEYS` | Fully trusted |
| Training host | Reads source data, writes signed artifact | Trusted (operator-controlled) |
| Serving host | Reads artifact directory, serves `/v1/recipes/{name}:<verb>` | Trusted (operator-controlled) |
| API client | Sends `/v1/recipes/{name}:<verb>` requests with an API key | Untrusted user input |
| Artifact file | Immutable signed binary; any tamper fails HMAC | Authenticated by HMAC |

Recipes can reference environment variables for dynamic values (via `${RECOTEM_RECIPE_*}` expansion). The expansion mechanism is restricted to that prefix and never applied inside `source.query` or `source.query_parameters` to foreclose SQL injection.

## Hot-swap

The serving process polls the recipes directory for artifact file changes. When the file mtime of a loaded artifact changes (because training wrote a new version), the watcher reloads that model in the background:

1. HMAC verify the new artifact.
2. Deserialize the payload.
3. Atomically replace the in-memory model reference.
4. The previous model is evicted; all subsequent requests use the new model.

Hot-swap is **recipe-scoped**: updating artifact `A` does not affect the in-flight model for recipe `B`. The serving process never restarts. If HMAC verification or deserialization of the new artifact fails, the previous model continues serving and the failure is recorded in `/v1/health` and in the `recotem_artifact_load_failures_total` Prometheus metric (when metrics are enabled).

The watcher poll interval is configured by `RECOTEM_WATCH_INTERVAL` (default 5 s, clamped to 1–30 s).

### Versioning and pointer files

The default `output.versioning: append_sha` mode writes artifacts as:

```
artifacts/news_articles.<sha8>.recotem
```

and atomically updates a pointer file at `artifacts/news_articles.recotem` (a trailing `.recotem` on `output.path` is stripped before the sha-suffix is appended). The server reads through the pointer. This means:
- No artifact is ever overwritten in-place.
- The pointer update is the only atomic operation the OS needs to guarantee.
- Old artifact versions remain on disk until pruned by the operator.

`always_overwrite` skips the pointer and writes directly to `output.path`. Suitable for object-storage backends where atomic rename is not available.

## Separation of training and serving

The `recotem.training` and `recotem.serving` packages **never import each other**. Shared types (e.g. `IDMappedRecommender`) live in neutral top-level modules (`recotem._idmap`). The CLI (`cli.py`) imports both sides, but only via function-local deferred imports so neither sub-package is loaded at CLI module import time.

This separation means:
- A container image used only for `recotem train` does not need the serving dependencies.
- A serving container does not need the training dependencies (Optuna, irspack training extras).
- The attack surface of each host is limited to its role.

## CLI summary

| Command | Purpose |
|---------|---------|
| `recotem train <recipe.yaml>` | Fetch data, run Optuna search, train best model, sign artifact |
| `recotem serve --recipes <dir>` | Start FastAPI `/v1/recipes` server with hot-swap |
| `recotem inspect <artifact>` | Read and verify artifact header (no payload deserialization) |
| `recotem validate <recipe.yaml>` | Validate recipe schema and probe data-source connectivity |
| `recotem schema` | Emit JSON Schema for the Recipe model (IDE integration) |
| `recotem keygen --type signing\|api` | Generate signing or API key |

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Unhandled / unmapped exception |
| 2 | `RecipeError` — schema, env expansion, path scheme |
| 3 | `DataSourceError` — CSV parse, missing column, BigQuery access |
| 4 | `TrainingError` — all trials failed, min-data violation |
| 5 | `ArtifactError` — magic / version / HMAC verify |
| 6 | `LockContestedError` — per-recipe training lock held by another process |
| 7 | `HttpFetchError` — SSRF guard / sha256 mismatch / redirect violation / byte cap |
| 8 | Configuration error — e.g. signing keys missing without `--dev-allow-unsigned` |

## Where to next

- [Recipe Reference](./recipe-reference) — every recipe field, type, default, and validation rule
- [CSV / Parquet Source](./data-sources/csv) — local, object-storage, and HTTP source options
- [BigQuery Source](./data-sources/bigquery) — authentication, parameter binding, GA4 patterns
- [SQL Source](./data-sources/sql) — PostgreSQL / MySQL / MariaDB / SQLite via SQLAlchemy 2
- [GA4 Source](./data-sources/ga4) — Google Analytics 4 Data API, skipping the BigQuery Export hop
- [Plugin Data Sources](./data-sources/plugins) — extend `source.type` with custom plugins
- Deployment guides — Docker, Kubernetes, cron scheduling
- Operations — key rotation, recovery, sizing, troubleshooting
- Security model — trust boundaries, FQCN allow-list, threat model
