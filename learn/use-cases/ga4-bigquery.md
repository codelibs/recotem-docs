---
title: Product Recommendations from GA4 + BigQuery
description: "Build GA4 recommendations from your BigQuery events export with Recotem: one SQL query, one recipe, then serve a live :recommend API — no ML code required."
---

# Product Recommendations from GA4 + BigQuery

If you already export Google Analytics 4 to BigQuery, you are sitting on
everything a recommender needs: which users looked at or bought which products,
and when. This guide turns that raw `events_*` export into a live
`/v1/recipes/{name}:recommend` API — a "recommended for you" and "customers who
viewed this also viewed…" service — using nothing but a SQL query, a recipe
file, and two Recotem commands. There is no notebook, no feature store, and no
model code to maintain.

It is written for engineers and analysts who run an e-commerce or content site
with GA4 → BigQuery export already enabled, and who want product
recommendations without adopting a hosted ML platform. If you are new to
Recotem, the [Tutorial](/guide/tutorial/) walks through the same
train → serve → recommend loop on a tiny CSV first.

## What you need

- **GA4 linked to BigQuery.** In the GA4 Admin → *BigQuery Links* panel, enable
  the export. GA4 writes one date-sharded table per day, named
  `events_YYYYMMDD`, into a dataset like `analytics_123456789`.
- **A service account with read access.** It needs `roles/bigquery.jobUser` on
  the project and `roles/bigquery.dataViewer` on the analytics dataset. See the
  full IAM matrix in the [BigQuery source reference](/docs/data-sources/bigquery).
- **Recotem installed with the BigQuery extra:**

```bash
pip install "recotem[bigquery]"
```

Recotem authenticates through Application Default Credentials (ADC) — it never
reads a credential out of the recipe. For local development:

```bash
gcloud auth application-default login
```

On GCE, GKE, Cloud Run, or Vertex AI the metadata server supplies credentials
automatically, so no key file is required.

## Shape the interactions

Recotem trains on a flat table of *(user, item, timestamp)* interactions. Your
job is to write one query that flattens GA4's nested event schema down to those
three columns. The column **aliases must match** the names you will reference in
the recipe's `schema` block — the BigQuery source hands the DataFrame straight
to training and does not rename or derive columns for you.

For an e-commerce store, the strongest signal is the standard GA4 e-commerce
events `view_item` and `purchase`. Both carry a repeated `items` record whose
`item_id` is exactly your product ID, so a single `UNNEST(items)` gives you one
row per user-product interaction:

```sql
SELECT
  user_pseudo_id                            AS user_id,
  item.item_id                              AS item_id,
  TIMESTAMP_MICROS(event_timestamp)         AS ts
FROM
  `my-project.analytics_123456789.events_*`,
  UNNEST(items) AS item
WHERE
  _TABLE_SUFFIX BETWEEN
    FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY))
    AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())
  AND event_name IN ('view_item', 'purchase')
  AND item.item_id IS NOT NULL
```

A few things this query gets right:

- **`_TABLE_SUFFIX` bounds the scan.** Filtering the shard suffix to a rolling
  90-day window means BigQuery only touches the tables in range, not the entire
  export history. The dates are computed in SQL with `CURRENT_DATE()` /
  `DATE_SUB()`, so the recipe needs no parameter binding to stay fresh.
- **`user_pseudo_id` is the portable user key.** It is present on every event.
  If you set a logged-in `user_id` via gtag and want cross-device history,
  swap the first column for `COALESCE(user_id, user_pseudo_id) AS user_id`.
- **Both events feed one implicit-feedback signal.** Views and purchases are
  treated as positive interactions. That is what implicit recommenders like
  IALS expect — you are modelling *engagement*, not ratings.

::: tip Watch what you scan
Recotem submits the query as a BigQuery dry-run during `recotem validate`, but
it does not set `maximum_bytes_billed`. On a large export, keep the
`_TABLE_SUFFIX` window tight and consider a project-level bytes-billed cap so a
runaway backfill can't surprise you on the invoice.
:::

For content sites without e-commerce tagging, you can derive the item from
`page_location` instead — see the [BigQuery source reference](/docs/data-sources/bigquery)
for the `REGEXP_EXTRACT` patterns.

## Write the recipe

A recipe is the single source of truth: one YAML file defines the data, the
training search, and where the signed model artifact is written. Save this as
`recipes/product_recs.yaml`:

```yaml
name: product_recs

source:
  type: bigquery
  project: my-project
  query: |
    SELECT
      user_pseudo_id                            AS user_id,
      item.item_id                              AS item_id,
      TIMESTAMP_MICROS(event_timestamp)         AS ts
    FROM
      `my-project.analytics_123456789.events_*`,
      UNNEST(items) AS item
    WHERE
      _TABLE_SUFFIX BETWEEN
        FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY))
        AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())
      AND event_name IN ('view_item', 'purchase')
      AND item.item_id IS NOT NULL

schema:
  user_column: user_id
  item_column: item_id
  time_column: ts

cleansing:
  drop_null_ids: true
  dedup: keep_last
  min_rows: 5000
  min_users: 100
  min_items: 50

training:
  algorithms: [IALS, RP3beta, TopPop]
  metric: ndcg
  cutoff: 20
  n_trials: 40
  timeout_seconds: 1800
  split:
    scheme: time_user
    heldout_ratio: 0.1
    seed: 42

output:
  path: ./artifacts/product_recs.recotem
  versioning: append_sha
```

What the important blocks do:

- **`schema`** maps the query's aliases to Recotem's roles. Because we set a
  `time_column`, we can use a time-aware split.
- **`cleansing`** de-duplicates repeat *(user, item)* pairs (`keep_last`) and
  refuses to train on too little data — if fewer than `min_rows` /
  `min_users` / `min_items` survive, training exits with a clear
  `min_data_violation` rather than producing a useless model.
- **`training.algorithms`** runs an Optuna search across IALS (implicit-feedback
  matrix factorization), RP3beta (a random-walk graph model), and TopPop (a
  popularity baseline). Recotem tunes each and keeps the best-scoring model by
  `ndcg@20`. TopPop guarantees the search never scores worse than "just show the
  bestsellers."
- **`split.scheme: time_user`** holds out each user's most recent 10% of
  interactions for evaluation, which mirrors how the model is used in
  production: predict the future from the past.

Every field is documented in the [Recipe Reference](/docs/recipe-reference).

### Optional: enrich responses with product metadata

The bare API returns `item_id` and `score`. To return titles, categories, or
image URLs alongside each recommendation, add an `item_metadata` block pointing
at a products file (CSV or Parquet) keyed by product ID:

```yaml
item_metadata:
  type: parquet
  path: gs://my-bucket/catalog/products.parquet
  fields: [title, category, image_url]
  item_id_column: item_id
```

Only the listed `fields` are joined into responses, so you control exactly what
leaves the server.

## Train and serve

Recotem signs every artifact with an HMAC key so the serving side can trust it.
Generate the keys once:

```bash
recotem keygen --type signing --kid dev
recotem keygen --type api     --kid dev
```

Export the values printed by each command:

```bash
export RECOTEM_SIGNING_KEYS="dev:<hex-from-signing>"
export RECOTEM_API_KEYS="dev:sha256:<hash-hex-from-api>"
export RECOTEM_API_PLAINTEXT="<plaintext-from-api>"   # used by curl below
```

Validate first — this runs a **free** BigQuery dry-run that checks your query
parses and that ADC works, without executing it or training anything:

```bash
recotem validate recipes/product_recs.yaml
```

Then train and serve:

```bash
mkdir -p artifacts
recotem train recipes/product_recs.yaml
recotem serve --recipes ./recipes/ --port 8080
```

`recotem train` runs the query, fetches the interactions (via the Storage Read
API when available), runs the Optuna search, and writes a signed artifact to
`./artifacts/`. `recotem serve` watches that directory, HMAC-verifies the new
artifact, and registers the endpoints. Confirm the model loaded:

```bash
curl -s http://localhost:8080/v1/health
```

```json
{"status": "ok", "total": 1, "loaded": 1}
```

## Call the recommendation API

The recipe `name` (`product_recs`) becomes the endpoint. Ask for
recommendations for a user, passing a `user_pseudo_id` value seen during
training:

```bash
curl -s -X POST http://localhost:8080/v1/recipes/product_recs:recommend \
  -H "X-API-Key: $RECOTEM_API_PLAINTEXT" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "1799394.3271658067", "limit": 5}'
```

```json
{
  "request_id": "a1b2c3d4e5f6",
  "recipe": "product_recs",
  "model_version": "sha256:a3f2c1...e91d",
  "items": [
    {"item_id": "SKU-4821", "score": 0.913, "title": "Merino Wool Beanie", "category": "accessories"},
    {"item_id": "SKU-1180", "score": 0.847, "title": "Thermal Base Layer", "category": "apparel"},
    {"item_id": "SKU-9032", "score": 0.802, "title": "Insulated Flask 750ml", "category": "gear"}
  ]
}
```

The `title` and `category` fields appear only if you configured
`item_metadata`; otherwise each item is just `item_id` + `score`. Items are
ordered by descending `score`.

::: tip Handle new users gracefully
A `user_pseudo_id` that was not in the training data returns
`404 UNKNOWN_USER`. This is expected for first-time visitors — catch it in your
app and fall back to bestsellers or a "related items" call — the
[Serving API reference](/docs/serving-api) notes that `UNKNOWN_USER` is an
expected client-side outcome, not a server error.
:::

For item-to-item recommendations that need no user — a "you may also like" strip
on a product page — call `:recommend-related` with seed product IDs instead:

```bash
curl -s -X POST http://localhost:8080/v1/recipes/product_recs:recommend-related \
  -H "X-API-Key: $RECOTEM_API_PLAINTEXT" \
  -H "Content-Type: application/json" \
  -d '{"seed_items": ["SKU-4821"], "limit": 5}'
```

The full request/response contract for every verb — including the batch
endpoints for pre-computing recommendations offline — is in the
[Serving API reference](/docs/serving-api).

## Keeping it fresh

Because the query computes its own rolling window with `CURRENT_DATE()`, you
only need to re-run `recotem train` on a schedule (a nightly cron job or a
Kubernetes CronJob) to pick up the latest events. Each run writes a new
`append_sha` artifact and updates a pointer file; the running server hot-swaps
to it atomically on its next watch interval, with no restart and no dropped
requests.

## Next steps

- [BigQuery Source reference](/docs/data-sources/bigquery) — parameter binding,
  the Storage Read API, and `page_location`-based item extraction for content
  sites.
- [Recommendations from Purchase Logs](/learn/use-cases/purchase-logs) — the
  same model from an e-commerce order CSV instead of GA4.
- [Add a Self-Hosted Recommendation API](/learn/use-cases/recommendation-api) —
  auth, deployment, and versioning for the serving layer.
- [AWS Personalize Alternative](/learn/compare/aws-personalize-alternative) —
  how this self-hosted approach compares to a managed service.
- [Learn Recotem](/learn/) — all use-case and comparison guides.
