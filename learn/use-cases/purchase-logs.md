---
title: Recommendations from Purchase Logs (E-commerce)
description: Build ecommerce recommendations from purchase history with Recotem — turn an order-log CSV into a "customers who bought this" API using IALS and RP3beta.
---

# Recommendations from Purchase Logs (E-commerce)

If you run an online store, the most valuable recommendation signal you already
own is your **purchase history**. Every completed order is an implicit vote:
this customer wanted this product. Recotem turns that order log — a plain CSV of
who bought what — into a live recommendation API, so you can power "customers
who bought this also bought…", personalized homepage rows, and post-purchase
cross-sell without a managed SaaS or a data-science team.

This page is the e-commerce walkthrough. If you would rather run the exact
commands against a ready-made public dataset first, do the
[official Tutorial](/guide/tutorial/) — it uses a hosted sample purchase log and
gets you to a served model in about ten minutes. Come back here when you want to
point Recotem at **your own** exported orders and understand the cleansing and
algorithm choices that matter for e-commerce data.

## What you need

- **Recotem installed** (`pip install recotem`) or the Docker image, plus a
  signing key and an API key. The [Tutorial](/guide/tutorial/) covers
  `recotem keygen` for both.
- **A CSV export of your purchase log** with at least a customer identifier and
  a product identifier per row. Most order tables or `SELECT` exports already
  have this.
- No GPU and no cluster. Training a store with tens of thousands of products
  runs on a laptop or a single small VM.

::: tip Data already in a warehouse?
If your orders live in BigQuery or a SQL database rather than a flat file, you
do not need to export a CSV at all — see
[GA4 + BigQuery](/learn/use-cases/ga4-bigquery) or point the SQL source at your
orders table. The recipe below is otherwise identical.
:::

## Shape your purchase log as a CSV

Recotem's [CSV source](/docs/data-sources/csv) reads a tabular file via pandas.
For purchase logs, one row per purchased line item is the natural shape:

```csv
user_id,item_id,timestamp,quantity
c-1001,sku-8843,2026-05-01T09:12:00Z,1
c-1001,sku-2290,2026-05-01T09:12:00Z,2
c-2087,sku-8843,2026-05-02T18:40:00Z,1
c-2087,sku-0142,2026-05-03T11:05:00Z,1
c-3120,sku-2290,2026-05-03T20:15:00Z,3
```

| Column | Role | Notes |
|--------|------|-------|
| `user_id` | customer identifier | Your CRM customer ID, account ID, or a stable pseudonymous ID. Mapped via `schema.user_column`. |
| `item_id` | product identifier | SKU, product ID, or variant ID. Mapped via `schema.item_column`. |
| `timestamp` | when the purchase happened | Used only for a time-based train/test split (see below). Optional if you split randomly. |
| `quantity` | units purchased | Illustrative only — Recotem models **implicit feedback** (the presence of a purchase), so quantity is not consumed as a weight. Keep it in the file if it is convenient; it is simply ignored. |

Recotem treats every (customer, product) pair as a positive signal. It does not
need ratings, stars, or explicit scores — the fact that the order happened is
the signal.

::: tip String IDs vs. numeric IDs
SKUs and customer IDs are identifiers, not numbers. Set
`dtype: {user_id: str, item_id: str}` on the source so pandas does not silently
turn `0042` into `42`. See the [CSV source dtype notes](/docs/data-sources/csv#dtype-overrides).
:::

## Clean the data before training

E-commerce logs are messy: repeat buyers, refunds re-inserted as rows, guest
checkouts with null IDs. The `cleansing` block gates data quality before any
model sees it. Every field is documented in the
[Recipe Reference](/docs/recipe-reference#cleansing):

- **`dedup: keep_last`** collapses duplicate (customer, product) pairs so a
  customer who bought the same SKU five times counts once. This is usually what
  you want for implicit feedback — otherwise heavy repeat purchases dominate the
  signal. Use `none` only if you have already de-duplicated upstream.
- **`drop_null_ids: true`** (the default) removes guest-checkout rows with a
  missing customer or product ID.
- **`min_rows` / `min_users` / `min_items`** are preconditions: if cleansing
  leaves fewer rows, users, or products than the threshold, training exits with
  a `min_data_violation` error instead of producing a weak model. Set them to
  values that reflect a healthy training set for your catalog.

::: warning Deduplication does not sort by time
`keep_first` / `keep_last` use the row order in the file, not the `timestamp`
column. If "keep the most recent purchase" matters, sort your CSV by timestamp
before training. See the [dedup notes](/docs/recipe-reference#cleansing).
:::

## Write the recipe

One recipe = one model = one `/v1/recipes/{name}:recommend` endpoint. Save this
as `recipes/purchase_history.yaml`:

```yaml
name: purchase_history

source:
  type: csv
  path: ./data/purchase_log.csv
  dtype:
    user_id: str
    item_id: str

schema:
  user_column: user_id
  item_column: item_id
  time_column: timestamp

cleansing:
  drop_null_ids: true
  dedup: keep_last
  min_rows: 5000
  min_users: 200
  min_items: 100

training:
  algorithms: [IALS, RP3beta, TopPop]
  metric: ndcg
  cutoff: 20
  n_trials: 40
  split:
    scheme: time_user
    heldout_ratio: 0.1
    seed: 42

output:
  path: ./artifacts/purchase_history.recotem
  versioning: append_sha
```

Why these choices for purchase data:

- **`algorithms: [IALS, RP3beta, TopPop]`** are all implicit-feedback models.
  **IALS** (implicit alternating least squares) is a strong matrix-factorization
  baseline for purchase data; **RP3beta** is a graph/random-walk model that often
  excels at "bought together" co-purchase patterns; **TopPop** is a popularity
  baseline entered as one more candidate — it is not a floor, and nothing
  guarantees the search returns anything better than it. Optuna tries each and keeps the
  best-scoring one. The full algorithm list is in the
  [Recipe Reference](/docs/recipe-reference#training).
- **`split.scheme: time_user`** holds out each customer's most recent purchases
  for evaluation, which mirrors how the model is used in production (predict the
  *next* order). This requires `schema.time_column`, which is why `timestamp` is
  mapped above.
- **`metric: ndcg`** with `cutoff: 20` scores a 20-item recommendation list —
  reasonable for a storefront row or a recommendations page.

::: tip Numeric (Unix-epoch) timestamps
If your `timestamp` column is an integer Unix time rather than an ISO string,
add `time_unit` (`s`, `ms`, `us`, or `ns`) under `schema` so Recotem interprets
it correctly. An ISO 8601 string like `2026-05-01T09:12:00Z` needs no `time_unit`.
:::

## Train and serve

Train the model from your recipe:

```bash
recotem train recipes/purchase_history.yaml
```

Recotem loads the CSV, cleanses it, runs the Optuna search across the three
algorithms, and writes a signed artifact to `./artifacts/`. Then serve the
directory of recipes:

```bash
recotem serve --recipes ./recipes/
```

The server loads the artifact, HMAC-verifies it, and registers the
`/v1/recipes/purchase_history:recommend` endpoint (plus the related and batch
verbs). Confirm it is ready:

```bash
curl -s http://localhost:8080/v1/health
```

```json
{"status": "ok", "total": 1, "loaded": 1}
```

## Get recommendations for a shopper

Ask the model what a specific customer is likely to buy next with the
[`:recommend` endpoint](/docs/serving-api#post-v1-recipes-name-recommend). The
`user_id` must be one seen during training; `exclude_items` is handy for hiding
products the customer already owns:

```bash
curl -s -X POST http://localhost:8080/v1/recipes/purchase_history:recommend \
  -H "X-API-Key: <plaintext>" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "c-1001", "limit": 10, "exclude_items": ["sku-8843"]}' | jq .
```

```json
{
  "request_id": "a1b2c3d4e5f6",
  "recipe": "purchase_history",
  "model_version": "sha256:a3f2...e91d",
  "items": [
    {"item_id": "sku-0142", "score": 0.91},
    {"item_id": "sku-2290", "score": 0.84}
  ]
}
```

::: tip New customers return 404
A first-time customer who was not in the training data returns `404 UNKNOWN_USER`
— this is expected, not a server error. Fall back to popular items (or a
`:recommend-related` call seeded by the product the shopper is viewing) in your
application. See the [Serving API notes](/docs/serving-api#post-v1-recipes-name-recommend).
:::

## "Customers who bought this" related items

The classic e-commerce widget — "customers who bought this also bought…" — does
not need a known customer at all. It is an **item-to-item** query: given the
product on the current page, find related products. Use
[`:recommend-related`](/docs/serving-api#post-v1-recipes-name-recommend-related)
with one or more seed SKUs:

```bash
curl -s -X POST http://localhost:8080/v1/recipes/purchase_history:recommend-related \
  -H "X-API-Key: <plaintext>" \
  -H "Content-Type: application/json" \
  -d '{"seed_items": ["sku-8843"], "limit": 5}' | jq .
```

The response has the same shape as `:recommend`, ranked by co-purchase affinity.
Because it takes the product the shopper is looking at rather than their history,
it works for anonymous and first-time visitors — exactly the case where
`:recommend` returns `UNKNOWN_USER`.

## Add product titles and categories (optional)

By default the API returns `item_id` and `score`. To return human-readable
fields — product title, category, image URL — attach an
[`item_metadata`](/docs/recipe-reference#item-metadata) block pointing at a
catalog file:

```yaml
item_metadata:
  type: csv
  path: ./data/products.csv
  item_id_column: sku      # column in products.csv that holds the SKU
  fields: [title, category, image_url]
  on_field_missing: error
```

Only the listed `fields` are joined into recommendation responses, so each item
comes back as `{"item_id": "sku-0142", "score": 0.91, "title": "…", "category": "…"}`.
Use `item_id_column` when your catalog's key column is named something other than
`item_id` (here, `sku`).

## Next steps

- [CSV / Parquet Source](/docs/data-sources/csv) — every field, path scheme, and
  encoding option for the data source.
- [Recipe Reference](/docs/recipe-reference) — full field-level documentation for
  cleansing, splits, and tuning.
- [Serving API](/docs/serving-api) — all endpoints, auth, and batch verbs for
  querying the model at scale.
- [Tutorial](/guide/tutorial/) — the same flow end-to-end against a hosted sample
  dataset.
- [Product Recommendations from GA4 + BigQuery](/learn/use-cases/ga4-bigquery) —
  do this straight from analytics events instead of an exported CSV.
- [E-commerce Product Recommendations](/learn/use-cases/ecommerce) — the
  planning layer: where widgets go on the store and how to measure their
  impact.
- Back to the [Learn hub](/learn/).
