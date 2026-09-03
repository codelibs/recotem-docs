---
title: "Recotem vs LightFM vs implicit: Choosing a Python Recommender"
description: "A lightfm alternative and python recommendation library comparison: LightFM vs implicit vs irspack, and where Recotem's train-tune-serve framework fits."
---

# Recotem vs LightFM vs implicit: Choosing a Python Recommender

If you are searching for a **LightFM alternative** or evaluating a
**Python recommendation library**, the first question is not "which model is
best" — it is "how much of the pipeline do I want to own?" LightFM and
`implicit` are excellent model libraries. Recotem is a framework that wraps a
model library ([irspack](https://github.com/tohtsky/irspack)) with data
loading, tuning, and a serving API. This page lays out the difference honestly
so you can pick the right tool.

## Library vs framework

A **library** gives you a model. You import it, feed it a sparse
user-by-item matrix that you have already built, call `fit`, and get an object
that can score items for a user. Everything around the model — pulling data out
of your warehouse, choosing and tuning the algorithm, evaluating it, and
exposing predictions over HTTP — is code you write and operate yourself. LightFM
and `implicit` are libraries in this sense.

A **framework** gives you the surrounding pipeline. Recotem takes a single
YAML recipe and runs the whole path: fetch data from your source, run a
multi-algorithm hyperparameter search, evaluate, and produce a signed artifact
that a bundled server hot-loads behind `POST /v1/recipes/{name}:recommend`. The
model itself comes from irspack; Recotem's job is everything on either side of
it.

Neither is "better" in the abstract. The right choice depends on how much
plumbing you want to build yourself.

## At a glance

The table below compares the two libraries with irspack (the engine) and
Recotem (the framework built on it). Maintenance facts are marked as of
2026-07 because they change over time.

| Dimension | LightFM | implicit | irspack | Recotem (on irspack) |
|---|---|---|---|---|
| Algorithms | Hybrid matrix factorization with BPR / WARP / WARP-kOS / logistic loss; can use item and user side-features | iALS, BPR, Logistic MF, and item-item KNN (cosine / TF-IDF / BM25) | IALS, KNN, RP3beta, DenseSLIM, TruncatedSVD, BPRFM, Mult-VAE | The irspack algorithms, selected per recipe (IALS, CosineKNN, TopPop, RP3beta, DenseSLIM, TruncatedSVD, BPRFM) |
| Hyperparameter tuning | Bring your own (e.g. Optuna, grid search) | Bring your own | Built-in Optuna search with early-stopping pruning per model | Recipe-driven multi-algorithm Optuna search with per-algorithm trial budgets |
| Evaluation | `precision_at_k`, `recall_at_k`, `auc_score`, reciprocal rank | `ranking_metrics_at_k` (precision, MAP, NDCG, AUC) | Fast C++/Eigen ranking metrics (NDCG, MAP, recall, hit, precision) | Uses irspack evaluation; picks the winning trial by the recipe's `metric` |
| Data loading | You build the sparse matrix | You build the sparse matrix | You build the sparse matrix | CSV / Parquet / BigQuery / SQL / plugins, declared in the recipe |
| Serving story | None — you write the service | None — you write the service | None — it is a training library | FastAPI endpoints, HMAC-signed artifacts, auth, hot-swap, batch verbs |
| GPU acceleration | CPU (Cython) | CPU + optional CUDA kernels for ALS/BPR | CPU (C++/Eigen) | CPU (C++/Eigen) |
| Maintenance (as of 2026-07) | Latest 1.17 (Mar 2023); low release activity, not archived | Active; latest v0.7.3 (May 2026) | Active; latest v0.5.2 (Jul 2026) | Active (this project) |

## LightFM

[LightFM](https://github.com/lyst/lightfm) is a hybrid matrix-factorization
library from Lyst. Its distinctive strength is that it learns embeddings for
**user and item metadata features**, not only IDs, which lets it make
reasonable predictions for users or items with little interaction history — a
partial answer to the cold-start problem. It supports BPR, WARP, WARP-kOS, and
logistic losses and ships a small evaluation module.

As of 2026-07 its most recent release is 1.17 (March 2023), following 1.16
(November 2020). The repository is not archived and still receives issues, but
release activity is low, so treat it as a stable, mature library in
maintenance mode rather than one under rapid development. If your problem hinges
on rich side-features, LightFM remains a strong, well-documented choice.

Worth noting: irspack — and therefore Recotem — can use LightFM directly. The
`BPRFM` algorithm is an irspack wrapper around LightFM's BPR/WARP factorization,
so choosing Recotem does not mean giving up LightFM's model; it means getting it
tuned and served for you alongside other algorithms.

## implicit

[`implicit`](https://github.com/benfred/implicit) is a fast collaborative-
filtering library for implicit-feedback data. It implements Alternating Least
Squares (iALS), Bayesian Personalized Ranking, Logistic Matrix Factorization,
and item-item nearest-neighbour models (cosine, TF-IDF, BM25). Training is
multi-threaded via Cython and OpenMP, and ALS/BPR have optional CUDA GPU
kernels, so it scales well to large matrices. It integrates with approximate
nearest-neighbour libraries (Faiss, Annoy, NMSLIB) to speed up retrieval and
ships a `ranking_metrics_at_k` evaluation helper.

As of 2026-07 it is actively maintained — v0.7.3 landed in May 2026, with
support tested across recent Python versions. If you want a lean, fast model
primitive and you are comfortable owning tuning, evaluation, and serving
yourself, `implicit` is an excellent pick, especially when GPU training matters.

## irspack: the engine inside Recotem

[irspack](https://github.com/tohtsky/irspack) is the algorithm, tuning, and
evaluation layer that Recotem is built on. It provides a family of
implicit-feedback recommenders (IALS, several KNN variants, RP3beta,
DenseSLIM, TruncatedSVD, BPRFM, Mult-VAE) implemented in C++/Eigen for speed,
**Optuna-backed hyperparameter optimization** with early-stopping pruning, and
fast ranking-metric evaluation (NDCG, MAP, recall, hit). Its core premise is
that there is no universally best recommender, so you should try several
algorithms, tune each, and let a validation metric decide.

irspack is itself a library: it does not fetch data from your warehouse and it
does not serve predictions. Its `IDMappedRecommender` maps your raw user and
item IDs to internal indices so you can predict with real IDs, but wiring it to
a data source and an HTTP endpoint is left to you. As of 2026-07, irspack is
actively maintained (v0.5.2, July 2026). Recotem 2.1.0 pins irspack 0.5.2;
Recotem 2.0.x pinned 0.4.2.

## Where Recotem fits: train + tune + serve on irspack

Recotem's framing is deliberate: **a library gives you a model; Recotem gives
you train, tune, and serve on top of irspack.** It keeps irspack as the engine
and adds the three layers a library leaves to you:

1. **A recipe format.** One YAML file declares the data source, column
   mapping, cleansing rules, the list of algorithms to try, the tuning budget,
   and the output. See the [Recipe Reference](/docs/recipe-reference) for every
   field.
2. **A recipe-driven search.** irspack does the per-model Optuna tuning; Recotem
   drives a multi-algorithm search across the recipe's `training.algorithms`,
   honours per-algorithm trial budgets, and selects the best model by the
   recipe's `metric`. Hyperparameter ranges come from each recommender's
   defaults in irspack.
3. **A serving API.** The winning model is written to an HMAC-signed artifact
   that `recotem serve` verifies and loads behind
   `POST /v1/recipes/{name}:recommend` (plus related-item and batch verbs), with
   API-key auth and file-mtime hot-swap so you can retrain without downtime.

A minimal recipe captures the whole pipeline:

```yaml
name: news_articles
source:
  type: csv
  path: ./interactions.csv
schema:
  user_column: user_id
  item_column: item_id
training:
  algorithms: [IALS, CosineKNN, TopPop]
  metric: ndcg
  n_trials: 40
output:
  path: ./artifacts/news_articles.recotem
```

```bash
recotem train recipe.yaml
recotem serve --recipes ./artifacts/
```

That is the trade-off in one screen: with a library you would write the data
loading, the search loop, the evaluation harness, and the web service around the
model yourself; with Recotem those are configuration.

## When a raw library is the better choice

Recotem is opinionated, and that does not fit every project. Reach for LightFM
or `implicit` directly when:

- **You only need the model.** You already have a training pipeline and a
  serving stack, and you just want a fast, well-tested recommender to slot in.
- **You need an algorithm or feature Recotem does not expose.** LightFM's rich
  side-feature embeddings or `implicit`'s CUDA-accelerated ALS may be exactly
  what your problem needs, and using them directly gives you full control.
- **You want to research or customize the model.** Direct library access lets
  you subclass, inspect internals, and experiment in ways a recipe field cannot.
- **Your integration is a notebook or a batch job**, not a live HTTP service —
  the serving layer that is Recotem's main value-add would go unused.

Conversely, if the work you are dreading is the plumbing — pulling data from
BigQuery or SQL, comparing several algorithms fairly, and standing up an
authenticated, hot-swappable prediction API — that plumbing is precisely what
Recotem provides on top of irspack.

## Next steps

- [Recipe Reference](/docs/recipe-reference) — every field that drives the
  train, tune, and serve pipeline.
- [Guide](/guide/) — install Recotem and train your first model end to end.
- [Open-Source Recommendation Systems Compared](/learn/compare/open-source) —
  how Recotem compares to Gorse, RecBole, and Merlin.
- [Learn Recotem](/learn/) — task-focused guides for building real
  recommenders.
