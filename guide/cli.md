---
title: CLI Reference
description: All six Recotem commands, their flags, and usage examples.
---

# CLI Reference

Recotem exposes six commands. Each is a self-contained process with well-defined exit codes that schedulers and CI systems can act on. Run `recotem <command> --help` for the full option list at any time.

---

## `recotem train`

Fetches data, runs a hyperparameter search, trains the best model, and writes a signed artifact.

```bash
recotem train <recipe.yaml> [flags]
```

**Common flags:**

| Flag | Default | Description |
|---|---|---|
| `--no-lock` | false | Skip the per-recipe file lock. Only safe when you guarantee no concurrent writers by other means. |
| `--fail-on-busy` | false | Exit 6 immediately if the lock is held by another process, instead of the default (skip and exit 0). Useful in orchestrators that treat non-zero exits as "retry elsewhere". |
| `--lock-timeout <seconds>` | `0.0` | How long to wait for the lock before failing. `0.0` = non-blocking; `-1` = wait indefinitely. |
| `-q` / `--quiet` | false | Suppress per-trial output from Optuna. Reduces log volume during large search budgets. |
| `-v` / `--verbose` | false | Print each trial's hyperparameter values. Useful for debugging; avoid in production. |
| `--run-id <id>` | random | Stable identifier for this training run. Reuse the same ID to resume a persistent Optuna study (requires `training.storage_path` in the recipe). |
| `--env-var KEY=VALUE` | — | Inject extra `RECOTEM_RECIPE_*` values for recipe variable expansion without exporting them to the shell. Repeatable. |
| `--dev-allow-unsigned` | false | Skip HMAC signing. Requires `RECOTEM_ENV=development` and the companion flag `--i-understand-this-loads-arbitrary-code`. Never use outside local development. |

**Example:**

```bash
recotem train recipes/news_articles.yaml --quiet --fail-on-busy
```

---

## `recotem serve`

Starts a FastAPI prediction server that loads all `*.yaml` recipes from a directory and hot-swaps models when new artifacts appear.

```bash
recotem serve --recipes <directory> [flags]
```

**Common flags:**

| Flag | Default | Description |
|---|---|---|
| `--recipes <dir>` | (required) | Directory containing `*.yaml` recipe files. |
| `--port` / `-p <port>` | `8080` (or `RECOTEM_PORT`) | Port to bind. |
| `--host` / `-H <host>` | `127.0.0.1` (or `RECOTEM_HOST`) | Host to bind. Set to `0.0.0.0` inside Docker or Kubernetes. |
| `--insecure-no-auth` | false | Disable API key authentication. Requires `RECOTEM_ENV` set to `development`, `dev`, or `test`. |
| `--dev-allow-unsigned` | false | Skip HMAC verification when loading artifacts. Requires `RECOTEM_ENV=development` and the companion flag `--i-understand-this-loads-arbitrary-code`. Never use outside controlled local testing. |

**Example:**

```bash
recotem serve --recipes ./recipes/ --port 8080
```

The server polls for new artifacts every `RECOTEM_WATCH_INTERVAL` seconds (default 5). When `recotem train` writes a new artifact, the server loads it and begins serving the updated model — no restart required.

---

## `recotem inspect`

Reads and verifies an artifact header without loading the model payload. Safe to run on potentially corrupt files; the HMAC check and size checks run before any deserialization.

```bash
recotem inspect <artifact-path-or-uri>
```

Accepts local paths and fsspec URIs:

```bash
recotem inspect ./artifacts/my_model.recotem
recotem inspect s3://my-bucket/artifacts/my_model.recotem
recotem inspect gs://my-bucket/artifacts/my_model.recotem
recotem inspect az://my-container/artifacts/my_model.recotem
recotem inspect https://host/artifacts/my_model.recotem
```

On success, prints `HMAC: OK  (kid=<kid>)` followed by the header JSON, which includes the recipe name, best algorithm, best score, training date, and data statistics.

Requires `RECOTEM_SIGNING_KEYS` to be set. If keys are absent and `--dev-allow-unsigned` is not passed, the command exits 8 (configuration error).

---

## `recotem validate`

Validates a recipe file against the schema and probes the data source for basic connectivity. This is a fast pre-flight check — it does not download the full dataset or run training.

```bash
recotem validate <recipe.yaml>
```

What it does:

1. Parses the YAML and checks all fields against the recipe schema.
2. Instantiates the data source plugin (catches missing extras like `recotem[bigquery]`).
3. Runs the source's optional `probe()` method — for HTTP/HTTPS sources this is an HTTP HEAD request; for BigQuery this verifies credentials.

**Example:**

```bash
recotem validate recipes/news_articles.yaml
# Recipe 'news_articles': schema OK
# DataSource: probe OK (csv)
# Validation passed.
```

If validation fails, the exit code tells you what went wrong (2 for a recipe schema error, 3 for a data source error). See [Exit Codes](/docs/exit-codes).

---

## `recotem schema`

Emits the JSON Schema for the Recipe model to standard output. Use this to enable autocompletion and inline validation in editors that support JSON Schema (VS Code, JetBrains IDEs, etc.).

```bash
recotem schema > recipe-schema.json
```

Configure your editor to validate `*.yaml` files against `recipe-schema.json`, or point a YAML language server at it. The emitted schema includes all registered data source types (CSV, Parquet, BigQuery, and any installed plugins).

---

## `recotem keygen`

Generates a signing or API key and prints the key ID, plaintext, and the ready-to-use environment variable entry.

```bash
recotem keygen --type signing --kid <name>
recotem keygen --type api     --kid <name>
```

| Flag | Default | Description |
|---|---|---|
| `--type` | `signing` | `signing` for an HMAC artifact key; `api` for a client authentication key. |
| `--kid <name>` | auto-generated (UUID prefix) | A short identifier for the key. Used in logs, the authenticated `/health/details` and `/models` endpoints, and rotation procedures. |

The plaintext is shown only once. Store it in a secrets manager immediately — there is no way to recover it later. If lost, generate a new key.

**Example:**

```bash
recotem keygen --type signing --kid prod-2026-q2
# kid=prod-2026-q2
# plaintext=<64-char hex>
# fingerprint=<8-char hex>  # matches server logs; NOT for config
# env_entry=RECOTEM_SIGNING_KEYS=prod-2026-q2:<64-char hex>
```

---

## Exit codes

All commands return a consistent set of exit codes. Use them in CI pipelines, cron scripts, and Kubernetes restart logic instead of parsing log output.

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Unexpected error (bug or environment issue) |
| 2 | Recipe error (bad YAML, schema violation, invalid env var) |
| 3 | Data source error (CSV format error, missing column, BigQuery access denied) |
| 4 | Training error (all trials failed, data below minimum threshold) |
| 5 | Artifact error (corrupt file, HMAC verification failed) |
| 6 | Lock contested (`--fail-on-busy` set and lock is held) |
| 7 | HTTP fetch error (SSRF guard refused, timeout, sha256 mismatch, byte cap exceeded) |
| 8 | Configuration error (missing signing keys, bad environment variable) |

For the full exit code reference with typical causes, see [Exit Codes](/docs/exit-codes).
