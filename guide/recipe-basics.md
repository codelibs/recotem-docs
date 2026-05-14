---
title: Recipe Basics
description: Walk through every section of a Recotem recipe file, with annotated examples.
---

# Recipe Basics

A recipe is the single configuration file for one recommender. It tells Recotem where the data is, which columns are user IDs and item IDs, what training options to use, and where to save the trained model. One recipe produces one model and one `/predict/{name}` HTTP endpoint.

You write a recipe once and then run `recotem train` as often as you like — on a schedule, after a data refresh, or whenever you want to try different settings. Every field has a sensible default; you only need to fill in what is specific to your data.

## Top-level structure

A recipe has seven sections:

```yaml
name: my_model          # required: the endpoint name
source: ...             # required: where the interaction data comes from
schema: ...             # required: which columns are user IDs and item IDs
cleansing: ...          # optional: data quality checks
item_metadata: ...      # optional: extra item details to include in predictions
training: ...           # required: which algorithms to try, how many trials
output: ...             # required: where to write the trained model file
```

---

## `name` — your endpoint name

The `name` value becomes the URL path: `name: purchase_log` → `/predict/purchase_log`.

```yaml
name: purchase_log
```

It must contain only letters, digits, hyphens, and underscores, and be at most 64 characters.

---

## `source` — where the data comes from

This section tells Recotem where to find the interaction data — the log of which users interacted with which items (purchases, clicks, reads, ratings). Use the `type` field to pick the data format.

### CSV or Parquet files

```yaml
source:
  type: csv
  path: ./data/interactions.csv
  dtype:
    user_id: str
    item_id: str
```

The `path` can be a local file path, a cloud storage URI (`s3://`, `gs://`, `az://`), or an `https://` URL. When using a URL, a `sha256` integrity pin is **required** — Recotem verifies the download matches the expected checksum before using it, so a silently corrupted or swapped file never makes it into training:

```yaml
source:
  type: csv
  path: https://example.com/data/interactions.csv
  sha256: 945fc769205a5976d38c5783500ae473afbb04608043b703951a699993c8f8be
```

For Parquet files, replace `type: csv` with `type: parquet`. The `path` and `sha256` fields work the same way.

### BigQuery

```yaml
source:
  type: bigquery
  query: |
    SELECT user_id, item_id, event_timestamp AS ts
    FROM `my-project.dataset.events`
    WHERE DATE(event_timestamp) >= @start_date
  query_parameters:
    start_date: "2026-01-01"
  project: my-gcp-project
```

Requires `pip install "recotem[bigquery]"`. Use named `@param` placeholders in the query for any values you want to vary — Recotem deliberately does not expand environment variables inside the SQL, which keeps the query safe from injection attacks.

---

## `schema` — column mapping

This section tells Recotem which column names in your data represent users, items, and (optionally) timestamps. These names must match the column headers in your source file.

```yaml
schema:
  user_column: user_id    # required
  item_column: item_id    # required
  time_column: ts         # required only when training.split.scheme is time_user or time_global
```

If your data calls users `customer_id` and items `product_sku`, write `user_column: customer_id` and `item_column: product_sku`.

---

## `cleansing` — data quality guardrails

Real-world interaction logs often contain duplicate rows, null IDs, and thin datasets that would silently produce poor models. The `cleansing` section lets you define checks that catch problems before training:

```yaml
cleansing:
  drop_null_ids: true    # remove rows where user_id or item_id is null
  dedup: keep_last       # for duplicate user+item pairs, keep the most recent row
  min_rows: 1000         # abort training if fewer than 1000 rows remain after cleansing
  min_users: 50
  min_items: 50
```

If the data falls below any `min_*` threshold, training exits with a clear error message rather than producing a degraded model. This is especially valuable in scheduled retraining: if your data pipeline delivers an unusually small dataset due to a bug, you want a failure alert — not a quietly broken recommendation model.

---

## `item_metadata` — item details in predictions

If you want `/predict` responses to include item details (titles, categories, image URLs), point this section to a metadata file. Only the columns listed in `fields` are joined and returned.

```yaml
item_metadata:
  type: parquet
  path: s3://my-bucket/items.parquet
  fields: [title, category, image_url]
  on_field_missing: error   # fail at model load if a listed field is missing
```

This section is optional. Without it, `/predict` returns only `item_id` and `score`.

---

## `training` — algorithm search

This section describes which recommendation algorithms to consider and how thoroughly to search for the best settings. Recotem uses [Optuna](https://optuna.org/) — a hyperparameter optimization library — to run trials across the chosen algorithms and pick the one with the highest score on a held-out validation set.

```yaml
training:
  algorithms: [IALS, CosineKNN, TopPop]
  metric: ndcg
  cutoff: 20
  n_trials: 40
  timeout_seconds: 1800
  split:
    scheme: time_user
    heldout_ratio: 0.1
    seed: 42
```

**Algorithms you can choose from:**

| Name | What it does |
|---|---|
| `IALS` | Implicit-feedback matrix factorization — a strong general-purpose choice |
| `CosineKNN` | Item-based similarity using cosine distance — interpretable and fast |
| `TopPop` | Popularity baseline — always recommends the most popular items |
| `RP3beta` | Graph-based random-walk algorithm |
| `DenseSLIM` | Dense variant of the SLIM item-to-item model |
| `TruncatedSVD` | Dimensionality reduction via Singular Value Decomposition |
| `BPRFM` | Bayesian Personalized Ranking with factorization machines |

You do not need to pick a winner upfront. List several candidates and let Optuna explore the space within your trial budget (`n_trials`). Including `TopPop` costs only a few trials and gives you a working baseline even if the more complex algorithms struggle on small datasets.

**Metric** (`ndcg`, `map`, `recall`, `hit`) defines what "best" means. NDCG (Normalized Discounted Cumulative Gain) is the default — it rewards putting the most relevant items near the top of the ranked list.

**Split scheme** controls how the validation set is built:

- `random` — held-out interactions are chosen randomly per user. Use when you have no timestamp column.
- `time_user` — for each user, hold out their most recent interactions. Closer to real-world evaluation.
- `time_global` — a single global time cutoff separates training from validation.

---

## `output` — where to save the model

```yaml
output:
  path: ./artifacts/my_model.recotem
  versioning: append_sha
```

The path can be local or a cloud storage URI (`s3://`, `gs://`, `az://`). With `versioning: append_sha` (the default), each training run writes a new file with a unique suffix and atomically updates a pointer file at `path`. The serving process reads through the pointer, so the switch from an old model to a new one is always atomic — requests never see a partial state.

---

## Before you run

Run `recotem validate` on any recipe before committing to a full training run. It checks the schema and probes the data source (for example, an HTTP HEAD request for a URL-based CSV) without downloading the full file:

```bash
recotem validate my_recipe.yaml
```

For the complete field-level reference — every default, constraint, and edge case — see the [Recipe Reference](/docs/recipe-reference).
