---
title: How to Build a Recommendation System in Python
description: How to build a recommendation system in Python — the full pipeline from interaction data to a live API, with the hand-rolled path and a runnable Recotem recipe.
---

# How to Build a Recommendation System in Python

If you want to build a recommendation system in Python, the good news is that
the hard parts are well understood and the ecosystem is mature. The bad news is
that a production recommender is not one model — it is a pipeline: you have to
collect interaction data, turn it into a matrix, choose and tune an algorithm,
evaluate it honestly, and then serve predictions behind an API that other
services can call.

This guide walks the whole pipeline. First the general steps that apply no
matter which tools you pick, then a brief honest look at the hand-rolled path
(numpy, scipy, or a library), and finally the streamlined path end to end with
[Recotem](/learn/) — a real, runnable recipe you can copy today. If you are new
to the terminology, start with
[What is a recommendation system?](/learn/concepts/recommendation-system).

## The five steps of any recommender pipeline

Every recommendation system, from a weekend prototype to a warehouse-scale
service, moves through the same five stages:

1. **Collect interactions.** Gather the events that connect users to items —
   purchases, clicks, plays, ratings. Most real signal is *implicit* (a click,
   not a five-star review). See
   [collaborative filtering](/learn/concepts/collaborative-filtering) for why
   these co-occurrence signals are enough.
2. **Represent the data.** Reshape those events into a sparse user-item matrix,
   where each non-zero cell means "this user interacted with this item."
3. **Choose an algorithm.** Pick a model family — nearest-neighbours, matrix
   factorization, a graph walk — and its hyperparameters.
4. **Train and evaluate.** Fit the model, then measure it offline on held-out
   interactions with a ranking metric such as nDCG@K or Recall@K.
5. **Serve.** Expose the trained model as an API so your app can ask for the
   top-K items for a user, or items related to a given item.

Steps 1–4 are a data-science problem. Step 5 — turning the model into a
reliable, authenticated, hot-swappable service — is where most projects stall.

## The hand-rolled path

You can build every step yourself in Python, and for learning or research that
is exactly the right move.

- **numpy + scipy.** Build the sparse matrix with `scipy.sparse.csr_matrix`,
  then factorize it (an SVD via `scipy.sparse.linalg.svds`, or your own
  alternating-least-squares loop). You control every detail and pull in no
  heavy dependencies.
- **A dedicated library.** Packages like `implicit`, `LightFM`, `Surprise`, or
  [`irspack`](https://github.com/tohtsky/irspack) implement well-tested
  recommenders so you do not re-derive iALS from scratch. Recotem itself is
  built on irspack.

The catch is everything *around* the model: a reproducible train/test split
that does not leak future interactions, a hyperparameter search so you are not
hand-guessing regularization strength, an ID map so string user IDs survive the
round trip, and then the serving layer — auth, input validation, atomic model
reloads, health checks. That plumbing is usually far more code than the model.

::: tip When hand-rolling is the right call
Reach for numpy/scipy or a raw library when you need a **custom loss, a novel
architecture, or research-grade control**, or when the recommender is a small
part of a larger training pipeline you already own. For the common case —
"I have interaction logs and want a good top-K API" — a recipe-driven tool
removes the boilerplate without taking the modelling decisions away from you.
:::

## The streamlined path with Recotem

Recotem collapses steps 3–5 into a single YAML **recipe** plus two commands. It
runs an [Optuna](https://optuna.org/) hyperparameter search over a set of
irspack algorithms, evaluates each with the ranking metric you pick, signs the
winning model into a portable artifact, and serves it over a FastAPI endpoint.
Install it with `pip install recotem`.

### Step 1 — Collect your interactions as a table

Recotem reads interactions from a CSV, Parquet file, BigQuery query, or SQL
database. The minimal shape is one row per interaction with a user column and an
item column:

```csv
user_id,item_id
1,42
1,17
2,42
3,88
```

For an e-commerce walkthrough that starts from an order export, see
[recommendations from purchase logs](/learn/use-cases/purchase-logs).

### Step 2 — Write the recipe (choose the algorithm here)

A recipe is the single source of truth: one YAML file = one model = one
`/v1/recipes/{name}:recommend` endpoint. This example trains on a small public
purchase-log CSV so you can run it verbatim — it is the same file Recotem's own
tests use. Save it as `recipe.yaml`:

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

The `training.algorithms` list is where you *choose the algorithm* — you name
several candidates and let the search pick the best. Recotem supports `IALS`
(implicit matrix factorization), `CosineKNN`, `TopPop` (a popularity baseline),
`RP3beta` (a graph walk), `DenseSLIM`, `TruncatedSVD`, and `BPRFM`. Every field
above is documented in the [Recipe Reference](/docs/recipe-reference).

::: warning HTTP/HTTPS sources need a checksum
Because this recipe fetches the CSV over HTTPS, the `sha256` pin is mandatory —
Recotem verifies the download before training so it never trains on a swapped
or corrupted file. For a local `path: ./data/interactions.csv` you omit it.
:::

### Step 3 — Train and evaluate in one command

Generate a signing key, then train:

```bash
recotem keygen --type signing --kid dev
export RECOTEM_SIGNING_KEYS="dev:<plaintext-hex-from-output>"

mkdir -p artifacts
recotem train recipe.yaml
```

Training does steps 3 and 4 together. Recotem holds out 20% of interactions
(`split.scheme: random`), runs the Optuna search across IALS and TopPop, scores
each trial with **nDCG@10** (`metric: ndcg`, `cutoff: 10`), and keeps the best.
The final log line reports the winner:

```json
{"event":"train_done","name":"purchase_log","exit_code":0,
 "artifact":"./artifacts/purchase_log....recotem","best_class":"IALSRecommender"}
```

The `best_score` and the metric it was chosen by are recorded inside the
artifact — read them any time with `recotem inspect`. If ranking metrics like
nDCG and Recall@K are unfamiliar, see
[recommender evaluation metrics](/learn/concepts/evaluation-metrics).

### Step 4 — Serve the model

```bash
recotem keygen --type api --kid dev
export RECOTEM_API_KEYS="dev:sha256:<hash-hex-from-output>"
export RECOTEM_API_PLAINTEXT="<plaintext-from-output>"

recotem serve --recipes ./
```

The server loads the signed artifact, HMAC-verifies it against your signing key,
and registers the `/v1/recipes/purchase_log:recommend` endpoint (plus the
related and batch verbs). Confirm it is ready:

```bash
curl -s http://localhost:8080/v1/health
```

```json
{"status": "ok", "total": 1, "loaded": 1}
```

### Step 5 — Get recommendations

Ask the model for a user's top items with a POST to the `:recommend` verb:

```bash
curl -s -X POST http://localhost:8080/v1/recipes/purchase_log:recommend \
  -H "X-API-Key: $RECOTEM_API_PLAINTEXT" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "1", "limit": 5}' | jq .
```

```json
{
  "request_id": "a1b2c3d4e5f6",
  "recipe": "purchase_log",
  "model_version": "sha256:a3f2...e91d",
  "items": [
    {"item_id": "42", "score": 0.91},
    {"item_id": "17", "score": 0.84}
  ]
}
```

Items come back ordered by descending `score`. From Python, the same call is a
short `requests` client — note the explicit handling of `404`, which the API
returns for a user who was not seen during training:

```python
import requests

BASE = "http://localhost:8080"
API_KEY = "<plaintext>"  # from `recotem keygen --type api`


def recommend(user_id: str, limit: int = 10) -> list[dict]:
    resp = requests.post(
        f"{BASE}/v1/recipes/purchase_log:recommend",
        headers={"X-API-Key": API_KEY},
        json={"user_id": user_id, "limit": limit},
        timeout=5,
    )
    if resp.status_code == 404:
        # UNKNOWN_USER: fall back to popular items in your app layer
        return []
    resp.raise_for_status()
    return resp.json()["items"]


for item in recommend("1", limit=5):
    print(item["item_id"], item["score"])
```

That is a complete recommendation system: a matrix built from your logs, a tuned
model chosen by offline nDCG, and an authenticated API — with no serving code of
your own. The full endpoint reference, including `:recommend-related` for
item-to-item widgets and the batch verbs, is in the
[Serving API](/docs/serving-api).

## Next steps

- [What is a recommendation system?](/learn/concepts/recommendation-system) —
  the concepts behind every step above.
- [Collaborative filtering explained](/learn/concepts/collaborative-filtering) —
  how interaction data alone produces recommendations.
- [Recommender evaluation metrics](/learn/concepts/evaluation-metrics) — read
  nDCG, MAP, and Recall@K correctly.
- [Recommendations from purchase logs](/learn/use-cases/purchase-logs) — the
  same pipeline applied to real e-commerce order data.
- [Tutorial](/guide/tutorial/) — run this recipe end to end, with Docker or pip.
- [Recipe Reference](/docs/recipe-reference) — every recipe field in detail.
- Back to the [Learn hub](/learn/).
