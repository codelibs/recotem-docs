---
title: Tutorial
description: Train a recommender from a real purchase log dataset and serve predictions in under 10 minutes.
---

# Tutorial

This tutorial walks you through a complete Recotem run: fetch data, train a model, serve it, and call the recommendation endpoint. The dataset is a small public purchase log CSV (the same file used by Recotem's own integration tests) and training takes about a minute on a laptop.

**Prerequisites:** either Docker with the Compose plugin, or Python 3.12+ with Recotem installed. About 50 MB of disk and network access to `raw.githubusercontent.com`.

Choose your path:

- [Path A — Docker Compose](#path-a-docker-compose) (recommended; no Python install needed)
- [Path B — pip](#path-b-pip)

---

## The tutorial recipe

The recipe at `examples/tutorial-purchase-log/recipe.yaml` describes the whole pipeline:

```yaml
name: purchase_log

source:
  type: csv
  path: https://raw.githubusercontent.com/codelibs/recotem/refs/tags/v1.0.0/frontend/e2e/test_data/purchase_log.csv
  sha256: 945fc769205a5976d38c5783500ae473afbb04608043b703951a699993c8f8be
  dtype:
    user_id: str
    item_id: str

schema:
  user_column: user_id
  item_column: item_id

cleansing:
  drop_null_ids: true
  dedup: keep_last
  min_rows: 100
  min_users: 10
  min_items: 10

training:
  algorithms: [IALS, TopPop]
  metric: ndcg
  cutoff: 10
  n_trials: 10
  split:
    scheme: random
    heldout_ratio: 0.2
    seed: 42

output:
  path: ./artifacts/purchase_log.recotem
  versioning: append_sha
```

A few things worth noting:

- **`source.sha256`** is required whenever a data file is fetched over HTTP or HTTPS. Recotem verifies the download matches the expected checksum before touching it. This prevents training on a silently swapped or corrupted file.
- **`training.algorithms`** lists two candidates: IALS (implicit-feedback matrix factorization) and TopPop (popularity baseline). Optuna runs trials for each and picks the best-scoring combination.
- **`output.versioning: append_sha`** writes each new artifact with a unique suffix and updates a pointer file. The server reads through the pointer, so hot-swapping is atomic.

---

## Path A — Docker Compose

### Step 1 — Generate keys

```bash
docker run --rm ghcr.io/codelibs/recotem:latest keygen --type signing --kid dev
```

Copy the `env_entry=` line from the output and set it:

```bash
export RECOTEM_SIGNING_KEYS="dev:<plaintext-hex-from-output>"
```

Then generate an API key:

```bash
docker run --rm ghcr.io/codelibs/recotem:latest keygen --type api --kid dev
```

Copy both the `env_entry=` line and the `plaintext=` line:

```bash
export RECOTEM_API_KEYS="dev:sha256:<hash-hex-from-output>"
export RECOTEM_API_PLAINTEXT="<plaintext-from-output>"   # used in Step 4 (curl)
```

### Step 2 — Train

From the repository root:

```bash
docker compose run --rm train
```

This runs a one-shot training container. It fetches the CSV from GitHub, verifies the sha256, runs the Optuna search, and writes a signed artifact to the `artifacts` volume shared with the serve container.

The last log line should look like:

```json
{"event":"train_done","name":"purchase_log","exit_code":0,
 "artifact":"./artifacts/purchase_log....recotem","best_class":"IALSRecommender"}
```

### Step 3 — Serve

```bash
docker compose up -d serve
```

Check that the server started and loaded the model:

```bash
curl http://localhost:8080/v1/health
```

Expected response:

```json
{"status":"ok","total":1,"loaded":1}
```

### Step 4 — Predict

```bash
curl -sX POST http://localhost:8080/v1/recipes/purchase_log:recommend \
  -H "X-API-Key: $RECOTEM_API_PLAINTEXT" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "1", "limit": 5}' | python3 -m json.tool
```

Expected response shape (exact scores and digest vary by training run):

```json
{
  "request_id": "...",
  "recipe": "purchase_log",
  "model_version": "sha256:7f9c2ba4e88f827d616045507605853ed73b8093a07ef41c995c66e94c4eaa1d",
  "items": [
    {"item_id": "42", "score": 0.91},
    {"item_id": "17", "score": 0.87}
  ]
}
```

`model_version` is `sha256:` followed by the 64-character hex SHA-256 of the loaded artifact — the same digest is also returned in the `X-Recotem-Model-Version` response header so clients can record exactly which model version produced each prediction.

### Step 5 — Tear down

```bash
docker compose down -v
```

---

## Path B — pip

### Step 1 — Install and verify

```bash
pip install recotem
recotem --help
```

### Step 2 — Generate keys

```bash
recotem keygen --type signing --kid dev
recotem keygen --type api     --kid dev
```

Export the values shown in the output:

```bash
export RECOTEM_SIGNING_KEYS="dev:<plaintext-hex-from-signing>"
export RECOTEM_API_KEYS="dev:sha256:<hash-hex-from-api>"
export RECOTEM_API_PLAINTEXT="<plaintext-from-api>"
```

### Step 3 — Validate the recipe (optional but recommended)

```bash
recotem validate examples/tutorial-purchase-log/recipe.yaml
```

This parses the recipe and runs the data source's `probe()` method without downloading the full file. For HTTP/HTTPS sources, the probe runs the SSRF host-publicity check; the full byte cap, redirect-scheme policy, and `sha256` verification still fire at fetch time. Useful for catching configuration problems before committing to a full training run.

### Step 4 — Train

Run from the repository root so the CWD-relative `output.path` (`./artifacts/...`) resolves correctly:

```bash
mkdir -p artifacts
recotem train examples/tutorial-purchase-log/recipe.yaml
```

### Step 5 — Serve

```bash
recotem serve --recipes examples/tutorial-purchase-log/
```

### Step 6 — Predict

In a separate terminal:

```bash
curl -sX POST http://127.0.0.1:8080/v1/recipes/purchase_log:recommend \
  -H "X-API-Key: $RECOTEM_API_PLAINTEXT" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "1", "limit": 5}' | python3 -m json.tool
```

---

## What just happened

- `recotem train` parsed the recipe, fetched the CSV over HTTPS, verified the sha256, ran an Optuna hyperparameter search across IALS and TopPop, and wrote a binary artifact signed with your signing key.
- `recotem serve` watched the artifact directory, found the new file, HMAC-verified it against the same signing key, and registered the `/v1/recipes/purchase_log:recommend` (and related verb) endpoints.
- The request was authenticated by the API key allow-list and scored using the trained model.

---

## Common issues

| Symptom | Likely cause | Fix |
|---|---|---|
| `RecipeError: 'source.path' uses a network scheme … requires a 'sha256' integrity pin` | The `sha256` field was removed from the recipe | Re-add the `sha256:` line |
| `DataSourceError: sha256 mismatch` | The upstream file changed | Re-compute with `curl -sL <url> \| shasum -a 256` and update the recipe |
| `DataSourceError: HTTP 404 fetching ...` | The URL changed | Verify the URL in a browser; check the `v1.0.0` tag is still present |
| `ArtifactError: RECOTEM_SIGNING_KEYS not set` | Step 1 (key generation) was not exported | Re-run the export and try again |
| `401 Unauthorized` on `/v1/recipes/...` | Wrong API key value | Use the `plaintext` line from `keygen --type api`, not the `hash` line |
| `503 RECIPE_UNAVAILABLE` immediately after training | The watcher has not polled yet | Wait up to `RECOTEM_WATCH_INTERVAL` seconds (default 5 s; the tutorial compose sets 10 s). Check `/v1/health`. |
| Path B: artifact written to the wrong directory | The recipe's `output.path` is relative to the working directory | Run `recotem train` from the repository root, or change `output.path` to an absolute path |
| `recotem: command not found` after pip install | The venv is not activated | Activate the venv, or run `python -m recotem ...` |

---

## Next steps

- [Recipe Basics](/guide/recipe-basics) — understand every section of a recipe in detail
- [CLI Reference](/guide/cli) — all flags for `train`, `serve`, and the other commands
- [Recipe Reference](/docs/recipe-reference) — full field-level documentation for every recipe field
- [Batch and Scheduling](/guide/batch) — run training on a cron schedule
