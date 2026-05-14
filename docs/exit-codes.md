---
title: Exit Codes & Errors
---

# Exit Codes & Errors

`recotem train`, `recotem serve`, `recotem inspect`, and `recotem validate` all map exceptions to a small set of well-defined exit codes. Use these in CI, cron wrappers, and Kubernetes Job restart logic instead of grepping stderr.

## Exit code table

| Code | Constant | Error class | Meaning |
|------|----------|-------------|---------|
| 0 | `_EXIT_SUCCESS` | — | Success (or lock contended without `--fail-on-busy`) |
| 1 | `_EXIT_UNKNOWN` | — | Unhandled / unmapped exception |
| 2 | `_EXIT_RECIPE` | `RecipeError` | Recipe schema / env / path scheme error |
| 3 | `_EXIT_DATASOURCE` | `DataSourceError` | Data source fetch failure |
| 4 | `_EXIT_TRAINING` | `TrainingError` | Training pipeline failure |
| 5 | `_EXIT_ARTIFACT` | `ArtifactError` | Artifact integrity / format error |
| 6 | `_EXIT_LOCK_CONTESTED` | `LockContestedError` | Per-recipe training lock held by another process |
| 7 | `_EXIT_HTTP_FETCH` | `HttpFetchError` | HTTP/HTTPS source fetch failure |
| 8 | `_EXIT_CONFIG` | `ConfigError` | Environment / configuration error |

---

## Per-code reference

### 0 — Success

The command completed normally. For `recotem train`, this also covers the case where a lock was already held and `--fail-on-busy` was **not** set — the run was skipped, but the process exits cleanly. Distinguish skips from actual training runs by looking for the `recipe_lock_contended_skipping` structured log event rather than relying solely on the exit code.

---

### 1 — Unknown error

An exception was raised that does not map to any domain error class. This typically indicates:

- A bug in Recotem or a dependency.
- An unexpected environment issue (disk full, out of memory, missing system library).
- A `schema` command failure during JSON schema generation.

**Recommended action:** Retry once. If the error persists, check the `internal_error` field in the `train_error` log event and file a bug report.

---

### 2 — RecipeError

`RecipeError` is raised when the recipe YAML cannot be loaded or validated. Common causes:

- YAML syntax error (indentation, invalid Unicode, etc.).
- Schema violation (unknown field, wrong type, value out of allowed range).
- Env-var expansion failure: an `${RECOTEM_RECIPE_*}` variable referenced in the recipe is not set, or the name does not match the allow-list prefix.
- A `--env-var KEY=VALUE` argument to `recotem train` where `KEY` does not start with `RECOTEM_RECIPE_`.
- `--dev-allow-unsigned` passed without the companion `--i-understand-this-loads-arbitrary-code` flag (maps to exit 8, not 2 — see ConfigError below).
- `source.path` or `item_metadata.path` using a disallowed scheme (e.g. a chained `::` fsspec protocol, or `memory://`).
- An embedded URI credential (username or password in a URI) was detected.

**Recommended action:** Fix the recipe YAML or the `--env-var` values. This is a persistent configuration error — do not retry without a fix.

---

### 3 — DataSourceError

`DataSourceError` is raised by the data source layer (not during HTTP fetch — that is exit 7). Common causes:

- CSV or Parquet format error (malformed file, wrong delimiter, encoding issue).
- A required column is missing from the source data.
- A local-FS path referenced in the recipe does not exist or is not readable.
- A BigQuery schema mismatch (column name or type does not match the recipe's expected schema).
- BigQuery API permission error (the service account cannot read the table).

**Recommended action:** Inspect the `train_error` log event for the `error` field. CSV/Parquet format errors and missing columns are persistent — fix the source or the recipe. BigQuery permission errors require IAM fixes. Network-level failures during the source fetch are exit 7, not exit 3.

---

### 4 — TrainingError

`TrainingError` is raised by the training pipeline. Subcodes are carried in the `train_error` log event's `code` field:

| Subcode | Meaning |
|---------|---------|
| `min_data_violation` | The cleaned dataset fell below `min_rows`, `min_users`, or `min_items`. The `train_error` event includes `n_rows`, `n_users`, `n_items`, `min_rows`, `min_users`, `min_items`. |
| `time_column_parse_error` | The timestamp column could not be parsed. |
| `no_completed_trials` | All Optuna trials failed before any completed. |
| `zero_score` | All completed trials scored 0.0. Usually indicates an empty test split. |
| `excessive_per_trial_timeouts` | Most trials hit the per-trial timeout. Increase `training.per_trial_timeout_seconds` in the recipe. |
| `final_training_error` | The final (refit) training step failed after hyperparameter search completed. |
| `signing_key_missing` | Signing key configuration is missing at artifact write time (also raises ConfigError in some paths — see exit 8). |

**Recommended action:** Retry for transient issues (network-adjacent data loads, flaky training). Do not retry `min_data_violation` without first investigating whether the data source is providing fewer rows than expected. For `zero_score` or empty test split issues, adjust the recipe's `split` or `cleansing` settings.

---

### 5 — ArtifactError

`ArtifactError` is raised when the artifact container is structurally invalid or its HMAC cannot be verified. Common causes:

- Magic bytes mismatch (the file is not a Recotem artifact, or is corrupt).
- Unknown version byte (artifact written by a newer version of Recotem).
- Unknown `kid` (the signing key used to sign the artifact is not in `RECOTEM_SIGNING_KEYS`).
- HMAC mismatch (artifact has been tampered with, or the wrong key is configured).
- Artifact or payload exceeds the configured size cap (`RECOTEM_MAX_ARTIFACT_BYTES` or `RECOTEM_MAX_PAYLOAD_BYTES`).
- Header JSON exceeds its size cap.
- A disallowed FQCN was found in the serialized payload (FQCN allow-list rejection during deserialization).

::: tip recotem inspect
`recotem inspect` is safe to run on suspect artifacts — it reads and verifies the HMAC header without deserializing the payload (which is where the FQCN allow-list applies). Use it to diagnose exit 5 errors before retraining.
:::

**Recommended action:** Run `recotem inspect <artifact>` to get the specific error message. A `signature mismatch` or `unknown kid` error means a key rotation procedure is incomplete — add the old kid back to `RECOTEM_SIGNING_KEYS` or retrain with the current key. A `magic bytes mismatch` means the file is corrupt — retrain.

Note: when `RECOTEM_SIGNING_KEYS` is absent and `--dev-allow-unsigned` is not passed, `recotem inspect` exits 8 (ConfigError), not 5.

---

### 6 — LockContestedError

`LockContestedError` is raised when `--fail-on-busy` is set and the per-recipe POSIX file lock is already held by another process. Without `--fail-on-busy` (the default), lock contention exits 0 with the structured event `recipe_lock_contended_skipping` — the run is silently skipped.

`LockContestedError` is intentionally outside the `TrainingError` hierarchy — it is an orchestration condition, not a training failure.

**Recommended action:** Schedule training runs with sufficient spacing so they do not overlap, or use the scheduler's own concurrency controls (Kubernetes `concurrencyPolicy: Forbid`, Argo `synchronization.mutex`, etc.). On the same host, you can also use `--lock-timeout <seconds>` to wait for the lock instead of failing immediately.

::: warning flock is host-local
The per-recipe lock uses POSIX `flock` and only coordinates writers on the **same host**. When `output.path` is a remote URI (`s3://`, `gs://`, etc.) the lock file is host-local and does not prevent concurrent writes from a second machine or pod. Use scheduler-level concurrency controls for cross-host coordination.
:::

---

### 7 — HttpFetchError

`HttpFetchError` is raised by the SSRF-guarded HTTP/HTTPS fetcher when a network source cannot be fetched. This is distinct from `DataSourceError` (exit 3): exit 7 covers failures during the HTTP fetch itself, while exit 3 covers failures in parsing or interpreting the data after it arrives.

Common causes:

- SSRF guard: the destination resolves to an RFC1918, loopback, or link-local address (blocked by default to protect cloud-metadata services). Set `RECOTEM_HTTP_ALLOW_PRIVATE=1` to permit these destinations (for trusted internal networks only).
- Connect or read timeout (exceeded `RECOTEM_HTTP_TIMEOUT_SECONDS`).
- HTTP 4xx or 5xx response.
- Redirect cap exceeded (the fetch was redirected too many times) or a scheme-changing redirect was detected.
- SHA-256 mismatch: the downloaded body does not match the `sha256` field in the recipe (required for `http://`/`https://` sources).
- Body size cap exceeded (`RECOTEM_MAX_DOWNLOAD_BYTES`).

**Recommended action:** Retry for transient network errors (timeouts, 5xx). Investigate for persistent errors (SSRF guard refusals, SHA-256 mismatches, 4xx responses). SHA-256 mismatches after a successful prior run indicate the source content changed — update the recipe's `sha256` field.

---

### 8 — ConfigError

`ConfigError` is raised for environment or configuration errors that prevent the process from starting or proceeding. Common causes:

- `RECOTEM_SIGNING_KEYS` is not set (required for all commands except those explicitly using `--dev-allow-unsigned`).
- `recotem inspect` invoked without `RECOTEM_SIGNING_KEYS` and without `--dev-allow-unsigned`.
- `--dev-allow-unsigned` passed when `RECOTEM_ENV` is not `development` (gate check).
- `--dev-allow-unsigned` passed without the companion `--i-understand-this-loads-arbitrary-code` flag.
- `RECOTEM_MAX_PAYLOAD_BYTES` > `RECOTEM_MAX_ARTIFACT_BYTES` (misconfiguration raises at serve startup).
- Bind port is already in use or permission denied (`EADDRINUSE`, `EACCES`, `EADDRNOTAVAIL`).
- An env var value is out of its clamped range in a way that prevents startup.

**Recommended action:** Do not retry without fixing the configuration. Check `RECOTEM_SIGNING_KEYS`, `RECOTEM_ENV`, and any env vars listed in the error message.

---

## --fail-on-busy interaction

By default, when `recotem train` cannot acquire the per-recipe lock it **exits 0** and emits the `recipe_lock_contended_skipping` structured log event. This is cron-friendly: a slow training run cannot cause subsequent scheduled runs to pile up failures.

Pass `--fail-on-busy` to flip this to exit 6:

```bash
recotem train --fail-on-busy /etc/recotem/recipes/my_recipe.yaml
```

Use `--fail-on-busy` when your orchestrator treats non-zero as "retry elsewhere" (for example, Kubernetes Jobs with `restartPolicy: OnFailure` and `backoffLimit > 0`, or Argo Workflow retry policies keyed on exit code 6).

When **not** using `--fail-on-busy`, alert on the `recipe_lock_contended_skipping` log event rather than on the exit code:

```bash
# Log-based alert (Datadog, CloudWatch, etc.)
event:"recipe_lock_contended_skipping"
```

---

## train_error structured log event

On any non-zero exit, `recotem train` emits a single `train_error` JSON log event. This is the primary mechanism for log-based alerting — more reliable than re-parsing process exit codes from cron logs.

Key fields:

| Field | Type | Description |
|-------|------|-------------|
| `event` | `"train_error"` | Event name (fixed). |
| `code` | string | Subcode identifying the specific failure. `internal_error` for non-domain exceptions. |
| `name` | string | Recipe name. |
| `run_id` | string | Run identifier (random 12-hex by default, or the value of `--run-id`). |
| `exit_code` | integer | The process exit code (2–8). |
| `error` | string | Human-readable error message. |
| `trained_at` | string | ISO 8601 timestamp of when the run started. |
| `kid` | string | Signing key kid, when known at the time of the error. |
| `n_rows`, `n_users`, `n_items` | integer | Data statistics, included when `code=min_data_violation`. |
| `min_rows`, `min_users`, `min_items` | integer | Configured thresholds, included when `code=min_data_violation`. |

Example:

```json
{
  "event": "train_error",
  "code": "min_data_violation",
  "name": "news_articles",
  "run_id": "a1b2c3d4e5f6",
  "exit_code": 4,
  "error": "Data precondition failed: n_rows=842 < min_rows=1000",
  "trained_at": "2026-05-14T03:00:01Z",
  "n_rows": 842,
  "min_rows": 1000,
  "n_users": 210,
  "min_users": 0,
  "n_items": 91,
  "min_items": 0
}
```

Alert on the `code` field rather than on the exit code number alone — the subcode provides enough information to route the alert to the correct team or runbook without re-parsing shell output.
