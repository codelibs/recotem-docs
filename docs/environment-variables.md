---
title: Environment Variables
---

# Environment Variables

This page is the authoritative reference for every `RECOTEM_*` environment variable. Variables scoped to `train` are read only by `recotem train`; those scoped to `serve` are read only by `recotem serve`; those scoped to `both` are read by both commands.

## Authentication and signing

These variables control artifact integrity (signing keys) and API authentication. They must be treated as secrets. See [Security — Secrets handling](./security#secrets-handling) for storage recommendations.

| Variable | Default | Scope | Clamping | Description |
|---|---|---|---|---|
| `RECOTEM_SIGNING_KEYS` | (required) | both | — | `kid:hex64,kid2:hex64` — HMAC-SHA256 sign/verify keys (64 hex chars = 32 raw bytes). Multi-entry enables zero-downtime rotation; `recotem train` always signs with the **first** entry. A misconfigured or missing value fails closed — there is no unsigned fallback. |
| `RECOTEM_API_KEYS` | (empty) | serve | — | `kid:sha256:hex64,...` — API key allow-list. Each entry is a kid paired with a scrypt digest (`sha256:` is a digest-family label, not the algorithm). Empty value forces the bind address to `127.0.0.1` regardless of `RECOTEM_HOST`. |

::: tip Generating keys
Use `recotem keygen --type signing` and `recotem keygen --type api` to generate correctly formatted values for these variables. See [Security — `recotem keygen` output format](./security#recotem-keygen-output-format) for the exact output format.
:::

## Network binding

These variables control where `recotem serve` listens for connections.

| Variable | Default | Scope | Clamping | Description |
|---|---|---|---|---|
| `RECOTEM_HOST` | `127.0.0.1` | serve | — | uvicorn bind host. Must be `0.0.0.0` inside Docker or Kubernetes when `RECOTEM_API_KEYS` is set. Forced back to `127.0.0.1` (with a `host_forced_to_loopback` warning) when no API keys are configured. |
| `RECOTEM_PORT` | `8080` | serve | — | uvicorn bind port. |
| `RECOTEM_ALLOWED_HOSTS` | `127.0.0.1,localhost` | serve | — | Comma-separated list passed to `TrustedHostMiddleware`. Requests with unrecognized `Host` headers are rejected. Whitespace-only comma input falls back to the default. Set this explicitly in production to the exact hostnames clients will use. |
| `RECOTEM_ALLOWED_ORIGINS` | (empty) | serve | — | Comma-separated CORS allow-list. Empty means deny all cross-origin requests. Set this when browser clients send CORS requests. |

::: warning Exposing recotem serve externally
To bind to a non-loopback interface you must configure `RECOTEM_API_KEYS`. Set `RECOTEM_HOST=0.0.0.0`, set `RECOTEM_ALLOWED_HOSTS` to the exact client hostnames, and place a TLS-terminating reverse proxy in front. `recotem serve` does not terminate TLS.
:::

## Limits and caps

These variables control memory and download size limits. All are enforced before deserialization.

| Variable | Default | Scope | Clamping | Description |
|---|---|---|---|---|
| `RECOTEM_MAX_ARTIFACT_BYTES` | 2 GiB | serve | [1 MiB, 16 GiB] | Per-artifact file size cap. Enforced before any deserialization occurs. Reduce this if you have many small models to lower the memory ceiling per artifact. |
| `RECOTEM_MAX_PAYLOAD_BYTES` | 512 MiB | serve | [1 MiB, 16 GiB] | Per-payload cap applied post-HMAC-verify during deserialization. Must be less than or equal to `RECOTEM_MAX_ARTIFACT_BYTES`; startup fails with a `ConfigError` (exit 8) if it is not. Smaller than `RECOTEM_MAX_ARTIFACT_BYTES` to bound the memory expansion from deserialization. |
| `RECOTEM_MAX_DOWNLOAD_BYTES` | 256 MiB | train | [1 MiB, 16 GiB] | Raw I/O bytes cap for HTTP/HTTPS, local file, and object-store source reads. The cap is applied mid-stream; exceeding it raises `DataSourceError` (exit 3). Does **not** cap the decompressed DataFrame — see [Security — Decompressed-size cap not enforced](./security#decompressed-size-cap-not-enforced-medium-5). |

## HTTP fetcher

These variables govern how `recotem train` fetches `http://` and `https://` source paths.

| Variable | Default | Scope | Clamping | Description |
|---|---|---|---|---|
| `RECOTEM_HTTP_TIMEOUT_SECONDS` | `30` | train | [1, 600] | Connect and read timeout in seconds for HTTP/HTTPS source fetches. |
| `RECOTEM_HTTP_ALLOW_PRIVATE` | (unset) | train | — | Truthy values: `1`, `true`, `yes`, `on`. When set, the HTTP fetcher will connect to private (RFC1918), loopback, and link-local destinations. Leave unset in production to block SSRF attacks against cloud-metadata services (AWS IMDSv1 at `169.254.169.254`, GCP metadata at `metadata.google.internal`). |

::: warning
`RECOTEM_HTTP_ALLOW_PRIVATE` should never be set in production. Its sole purpose is to support lab environments where the data origin is a trusted internal host. See [Security — Operator responsibilities for network sources](./security#operator-responsibilities-for-network-sources).
:::

## Watcher and startup

These variables control how `recotem serve` monitors artifact files and loads models at startup.

| Variable | Default | Scope | Clamping | Description |
|---|---|---|---|---|
| `RECOTEM_WATCH_INTERVAL` | `5` | serve | [1, 30] | Artifact watcher poll interval in seconds. The watcher detects new or changed artifact files and hot-swaps models without restarting the process. |
| `RECOTEM_STARTUP_PARALLELISM` | (auto) | serve | [1, 32] | Number of parallel threads used to load artifacts at startup. Default auto-sizing is `min(len(recipes), 8)`. Setting to `0` is not a sentinel — it clamps to 1 and emits an `env_var_clamped` warning. Set to `1` to force sequential loading for debugging. |

## Lifecycle

These variables control the runtime environment, graceful shutdown, and log output.

| Variable | Default | Scope | Clamping | Description |
|---|---|---|---|---|
| `RECOTEM_ENV` | (empty) | serve | — | Deployment environment tag. `--insecure-no-auth` is permitted only when set to `development`, `dev`, or `test`. `--dev-allow-unsigned` is permitted only when set to `development`. When set to `production`, `prod`, or `staging`, the `/docs`, `/redoc`, and `/openapi.json` endpoints are disabled (requests return 404). |
| `RECOTEM_DRAIN_SECONDS` | `30` | serve | [1, 300] | SIGTERM graceful drain window in seconds. In-flight requests are given this window to complete before uvicorn closes remaining connections. For Kubernetes, set `terminationGracePeriodSeconds` to at least `RECOTEM_DRAIN_SECONDS + 5`. |
| `RECOTEM_LOG_FORMAT` | `auto` | both | — | Log output format. `auto` uses JSON when stdout is not a TTY, console otherwise. `json` forces structured JSON. `console` forces human-readable output. |

## Operational

These variables configure storage paths, locking, metadata field filtering, metrics, and BigQuery behaviour.

| Variable | Default | Scope | Clamping | Description |
|---|---|---|---|---|
| `RECOTEM_ARTIFACT_ROOT` | (empty) | train | — | If set, local `output.path` values in recipes must lie under this directory. Symlink escapes are rejected. Use this to confine where train processes can write artifacts on the host. |
| `RECOTEM_LOCK_DIR` | (empty) | train | — | Override directory for per-recipe training lock files. Local `output.path` values always lock at `<output_path>.lock`. Remote `output.path` values (`s3://`, `gs://`, etc.) require a host-local lock file; if `RECOTEM_LOCK_DIR` is unset they fall back to `<tempdir>/recotem-locks/`. Note: `flock` is host-local — for cross-host single-writer guarantees use scheduler-level mutex (Kubernetes `concurrencyPolicy: Forbid`, etc.). |
| `RECOTEM_METADATA_FIELD_DENY` | (empty) | serve | — | Comma-separated list of column names stripped from `/predict` responses after the item-metadata join. Matching is case-insensitive — `"Internal_ID"` in the metadata is stripped if `"internal_id"` is in the deny list. Use this to keep PII columns out of API responses. |
| `RECOTEM_METRICS_ENABLED` | (unset) | serve | — | Truthy values: `1`, `true`, `yes`, `on`. Enables the Prometheus `/metrics` endpoint. Requires the `recotem[metrics]` extra (`pip install "recotem[metrics]"`). The endpoint is opt-in and off by default. |
| `RECOTEM_BQ_REQUIRE_STORAGE_API` | (unset) | train | — | Truthy values: `1`, `true`, `yes`, `on`. When set, the BigQuery source raises `DataSourceError` (exit 3) instead of silently falling back to the slower REST API when the BigQuery Storage Read API fails (e.g. missing `bigquery.readSessions.create` IAM permission). Use this to surface IAM gaps rather than accepting degraded throughput. |

## Recipe expansion

Variables with the `RECOTEM_RECIPE_` prefix are the only variables eligible for `${...}` expansion inside recipe YAML files.

| Variable | Default | Scope | Description |
|---|---|---|---|
| `RECOTEM_RECIPE_*` | — | train | Any variable whose name starts with `RECOTEM_RECIPE_` is a candidate for `${VAR_NAME}` substitution in recipe fields. A secondary blacklist blocks sensitive names even within this prefix. |

::: warning Security constraints on RECOTEM_RECIPE_* expansion
A secondary blacklist refuses expansion of variables whose names match sensitive patterns even if they carry the `RECOTEM_RECIPE_` prefix. The blacklist uses exact match, prefix match, and substring match rules — notably, any name containing the substring `KEY` is rejected. The `RECOTEM_RECIPE_` prefix is intended for non-sensitive configuration values such as dataset names, date ranges, partition columns, and feature flags. Never store secrets under this prefix. See [Security — Recipe env-var expansion blacklist](./security#recipe-env-var-expansion-blacklist) for the full rules and examples.
:::
