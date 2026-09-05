---
title: Installation
description: Install Recotem via pip or Docker, generate keys, and verify the setup.
---

# Installation

Recotem requires **Python 3.12 or newer**. There are two ways to install it: as a Python package or as a Docker image. Both give you exactly the same CLI and behaviour.

## Option A — pip

```bash
pip install recotem
```

Verify the install worked:

```bash
recotem --help
```

You should see a list of six commands: `train`, `serve`, `inspect`, `validate`, `schema`, and `keygen`. If the shell cannot find `recotem`, the package was installed into a virtual environment that is not on your `PATH`. Activate the environment first, or run `python -m recotem --help`.

### Optional extras

The core package ships with CSV and Parquet data sources. Install extras for additional capabilities:

| Extra | Command | What it adds |
|---|---|---|
| BigQuery data source | `pip install "recotem[bigquery]"` | Read interaction data from Google BigQuery |
| PostgreSQL data source | `pip install "recotem[postgres]"` | Read interaction data from PostgreSQL via psycopg |
| MySQL / MariaDB data source | `pip install "recotem[mysql]"` | Read interaction data from MySQL or MariaDB via PyMySQL |
| SQLite data source | `pip install "recotem[sqlite]"` | Read interaction data from SQLite (uses stdlib `sqlite3`) |
| Amazon S3 | `pip install "recotem[s3]"` | Read/write artifacts and data from S3 |
| Google Cloud Storage | `pip install "recotem[gcs]"` | Read/write artifacts and data from GCS |
| Azure Blob Storage | `pip install "recotem[azure]"` | Read/write artifacts and data from Azure |
| Prometheus metrics | `pip install "recotem[metrics]"` | Opt-in `/v1/metrics` endpoint for monitoring (requires `X-API-Key`) |
| `BPRFM` algorithm | `pip install "recotem[bprfm]"` | Makes the `BPRFM` algorithm available to `training.algorithms` |
| Everything | `pip install "recotem[all]"` | All of the above at once |

Extras can be combined: `pip install "recotem[s3,metrics]"`.

::: warning `BPRFM` needs its extra
irspack gates `BPRFMRecommender` behind the separately installed `lightfm` package and drops the class from its exports when that import fails. Listing `BPRFM` in `training.algorithms` without the `bprfm` extra makes both `recotem validate` and `recotem train` exit **4** with `irspack does not know recommender class 'BPRFMRecommender'`, before any data is fetched. The official Docker image already includes it. One serving limitation comes with it: a recipe whose search winner is BPRFM cannot answer `:recommend-related` or `:batch-recommend-related`, which return `501 RELATED_NOT_SUPPORTED` (see [Serving API](/2.1/docs/serving-api#post-v1-recipes-name-recommend-related)).

The dependency is [`lightfm-next`](https://pypi.org/project/lightfm-next/), a maintained fork that installs the same `lightfm` module — upstream `lightfm` has shipped no release since 1.17 and does not build on Python 3.12. Two caveats: it publishes no linux/aarch64 wheel, so on arm64 `pip install "recotem[bprfm]"` builds it from source and needs a C compiler (the published image is unaffected, having compiled it at build time on both architectures); and on macOS it is built without OpenMP, so BPRFM training there is single-threaded.
:::

## Option B — Docker

The official image is published to GitHub Container Registry:

```bash
docker pull ghcr.io/codelibs/recotem:latest
```

The image runs as a non-root user (UID 1000). Mount your recipe directory and artifact directory as volumes when training or serving. The tutorial's `compose.yaml` shows a complete working example — see the [Tutorial](/2.1/guide/tutorial/).

Verify the image works:

```bash
docker run --rm ghcr.io/codelibs/recotem:latest --help
```

## Generating keys

Recotem uses two kinds of keys. You need to generate them once before running `train` or `serve`.

### Signing key

The signing key protects the integrity of trained model artifacts. `recotem train` uses it to sign each artifact; `recotem serve` uses it to verify the artifact before loading. If the artifact has been tampered with or corrupted, verification fails and the model is not loaded.

```bash
recotem keygen --type signing --kid prod
```

Output:

```
kid=prod
plaintext=<64-char hex string>
fingerprint=<8-char hex>  # informational only; matches server logs
env_entry=RECOTEM_SIGNING_KEYS=prod:<64-char hex string>
```

Copy the `env_entry` line and export it in your shell (or store it in a secrets manager):

```bash
export RECOTEM_SIGNING_KEYS="prod:<64-char hex string>"
```

### API key

The API key controls who can call the serving API: every endpoint except the three unauthenticated probes (`GET /v1/health`, `GET /v1/health/live`, `GET /v1/health/ready`) requires it, including `/v1/recipes/{name}:recommend` and the other recipe verbs. Clients send it as an `X-API-Key` HTTP header. The server stores only a hash of the key, not the plaintext.

```bash
recotem keygen --type api --kid client-a
```

Output:

```
kid=client-a
plaintext=<43-char base64url string>  ← share this with API clients
hash=sha256:<64-char hex>
env_entry=RECOTEM_API_KEYS=client-a:sha256:<64-char hex>
```

Export the `env_entry` line for the server, and keep the `plaintext` line to pass as the `X-API-Key` header from clients:

```bash
export RECOTEM_API_KEYS="client-a:sha256:<64-char hex>"
export RECOTEM_API_PLAINTEXT="<43-char base64url string>"
```

If `RECOTEM_API_KEYS` is not set, the server binds to `127.0.0.1` only (loopback). Set API keys before exposing the server on a network interface.

## Summary: what each variable is for

| Variable | Used by | Purpose |
|---|---|---|
| `RECOTEM_SIGNING_KEYS` | `train` and `serve` | HMAC sign and verify artifact files |
| `RECOTEM_API_KEYS` | `serve` | Authenticate `/v1` API callers (server stores hash only) |
| `X-API-Key: <plaintext>` | HTTP clients | Sent on every `/v1` request except the three probes `GET /v1/health`, `GET /v1/health/live`, `GET /v1/health/ready` |

Both `RECOTEM_SIGNING_KEYS` and `RECOTEM_API_KEYS` accept multiple comma-separated entries (`kid1:value,kid2:value`) to enable key rotation without downtime. See the [Operations](/2.1/docs/operations) guide for the rotation procedure.

## Next step

Follow the [Tutorial](/2.1/guide/tutorial/) to train and serve your first recommender in under 10 minutes.
