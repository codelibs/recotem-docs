---
title: "Implicit-Feedback Recommendations: Step-by-Step Tutorial"
description: An implicit feedback recommendation tutorial with Recotem — turn raw event logs into interaction rows, pick IALS or RP3beta, then train, serve, and evaluate a model.
---

# Implicit-Feedback Recommendations, Step by Step

Most recommendation data is **implicit**: clicks, plays, views, add-to-carts,
and purchases. Nobody rated anything on a five-star scale — users just *did*
things, and each action is a quiet signal of preference. This is an implicit
feedback recommendation tutorial: it takes you from a raw event log to a live
`/v1/recipes/{name}:recommend` endpoint with Recotem, and shows how to evaluate
the result with ranking metrics.

If you want the conceptual background first — why implicit signals dominate in
practice, and how they differ from explicit ratings — read
[Implicit vs Explicit Feedback](/learn/concepts/implicit-explicit-feedback).
This page is the hands-on companion.

## What "implicit feedback" means for training

Recotem models implicit feedback as the **presence or absence of an
interaction**. Every `(user, item)` pair that appears in your data is a positive
signal; everything else is treated as "unobserved," not "disliked." There are no
ratings to predict — the model learns to rank items a user is likely to interact
with next.

Two consequences shape the whole workflow:

- You never need a rating column. A row that says "user `u1` touched item `i9`"
  is enough.
- Repeat counts and quantities are **not** used as weights. Recotem collapses
  duplicate `(user, item)` pairs during cleansing, so buying something five times
  or playing a track fifty times counts once. The signal is *that* it happened.

## Step 1 — Turn raw event logs into interaction rows

Raw event logs are rarely in the shape a recommender wants. A typical stream has
many event types, several rows per user-item pair, and columns you do not need:

```csv
user_id,track_id,event,ts
u-1001,trk-8843,play,2026-05-01T09:12:00Z
u-1001,trk-8843,skip,2026-05-01T09:13:10Z
u-1001,trk-2290,play,2026-05-01T09:20:00Z
u-1001,trk-2290,like,2026-05-01T09:21:00Z
u-2087,trk-8843,play,2026-05-02T18:40:00Z
u-2087,trk-0142,play,2026-05-03T11:05:00Z
u-3120,trk-2290,impression,2026-05-03T20:10:00Z
```

Turning this into interaction rows means making three decisions:

1. **Which events count as a positive?** Pick the action that expresses genuine
   intent. A `play` (or a `purchase`, a `complete`, an `add_to_cart`) is a strong
   signal; a bare `impression` usually is not. Filtering to one meaningful event
   type keeps noise out of the model.
2. **Which columns map to user, item, and time?** A recommender only needs a user
   identifier, an item identifier, and — if you want a time-based evaluation split
   — a timestamp. Drop the rest.
3. **How do you handle duplicates?** One user plays the same track many times. You
   *could* pre-aggregate, but you do not have to: Recotem's `cleansing.dedup`
   collapses repeated `(user, item)` pairs for you.

After filtering to `play` events and keeping the three columns that matter, the
interaction table is simply:

```csv
user_id,item_id,ts
u-1001,trk-8843,2026-05-01T09:12:00Z
u-1001,trk-2290,2026-05-01T09:20:00Z
u-2087,trk-8843,2026-05-02T18:40:00Z
u-2087,trk-0142,2026-05-03T11:05:00Z
```

You can do this filtering in whatever tool exports your data (a `SELECT ... WHERE
event = 'play'`, a pandas script, a dbt model). If your events already live in a
warehouse, you can skip the CSV export entirely and let a query do it — see
[GA4 + BigQuery](/learn/use-cases/ga4-bigquery), where a single SQL statement
turns analytics events into interaction rows. For an e-commerce order log worked
end-to-end, see [Recommendations from Purchase Logs](/learn/use-cases/purchase-logs).

::: tip Keep IDs as strings
Track IDs, SKUs, and user IDs are identifiers, not numbers. Set
`dtype: {user_id: str, item_id: str}` on the source so pandas does not turn
`0042` into `42`. See the [CSV source dtype notes](/docs/data-sources/csv#dtype-overrides).
:::

## Step 2 — Choose an implicit-feedback algorithm

Recotem trains on [irspack](https://github.com/tohtsky/irspack) and exposes a
set of algorithms tuned for implicit data. You do not have to pick just one —
list several and let the Optuna search keep the best-scoring model. For an
implicit workflow, three algorithms cover most cases:

- **IALS** (implicit alternating least squares) — a matrix-factorization model
  designed specifically for implicit feedback. It is the strong general-purpose
  baseline: it learns latent user and item factors and handles large, sparse
  interaction matrices well.
- **RP3beta** — a graph / random-walk model over the user-item bipartite graph.
  It often shines at "co-interaction" patterns ("people who played this also
  played…") and is cheap to train.
- **TopPop** — recommends the most popular items to everyone. It is not
  personalized, but it is a useful floor: if a fancy model cannot beat
  popularity on your data, that is worth knowing.

Other implicit-capable algorithms — `CosineKNN`, `DenseSLIM`, `TruncatedSVD`,
`BPRFM` — are available too. The full list and how tuning works is in the
[Recipe Reference](/docs/recipe-reference#training). Which of collaborative
filtering's flavors these belong to is covered in
[Implicit vs Explicit Feedback](/learn/concepts/implicit-explicit-feedback).

## Step 3 — Write the recipe

One recipe = one model = one `/v1/recipes/{name}:recommend` endpoint. Save this
as `recipes/track_plays.yaml`:

```yaml
name: track_plays

source:
  type: csv
  path: ./data/interactions.csv
  dtype:
    user_id: str
    item_id: str

schema:
  user_column: user_id
  item_column: item_id
  time_column: ts

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
  path: ./artifacts/track_plays.recotem
  versioning: append_sha
```

Why these settings for implicit data:

- **`dedup: keep_last`** collapses repeated `(user, item)` plays into a single
  positive, so heavy repeat listeners do not swamp the signal.
- **`algorithms: [IALS, RP3beta, TopPop]`** are all implicit-feedback models;
  Optuna tries each and keeps the best.
- **`split.scheme: time_user`** holds out each user's most recent interactions
  for evaluation, mirroring production use (predict what they touch *next*). This
  requires `schema.time_column`, which is why `ts` is mapped. If your rows carry
  no reliable time, use `scheme: random` and drop `time_column`.
- **`metric: ndcg`** with `cutoff: 20` scores a 20-item ranked list — a ranking
  metric, which is the right family for implicit models (there are no ratings to
  measure error against). Every recipe field is documented in the
  [Recipe Reference](/docs/recipe-reference).

::: warning Deduplication uses row order, not time
`keep_first` / `keep_last` collapse duplicates by the order rows appear in the
file, not by the `ts` column. If "keep the most recent event" matters, sort the
CSV by time before training. See the
[dedup notes](/docs/recipe-reference#cleansing).
:::

## Step 4 — Train

Point `recotem train` at the recipe:

```bash
recotem train recipes/track_plays.yaml
```

Recotem loads the CSV, applies the cleansing gates, runs the Optuna search across
the three algorithms against `metric: ndcg` at `cutoff: 20`, and writes a signed
artifact to `./artifacts/`. The best algorithm and its validation score are
recorded in the artifact header, which you can read without deserializing the
model:

```bash
recotem inspect ./artifacts/track_plays.recotem
```

## Step 5 — Serve and call `:recommend`

Serve the directory of recipes:

```bash
recotem serve --recipes ./recipes/
```

The server loads the artifact, HMAC-verifies it, and registers the
`/v1/recipes/track_plays:recommend` endpoint (plus the related and batch verbs).
Confirm it is ready:

```bash
curl -s http://localhost:8080/v1/health
```

```json
{"status": "ok", "total": 1, "loaded": 1}
```

Now ask the model what a specific user is likely to play next with the
[`:recommend` endpoint](/docs/serving-api#post-v1-recipes-name-recommend). The
`user_id` must be one seen during training:

```bash
curl -s -X POST http://localhost:8080/v1/recipes/track_plays:recommend \
  -H "X-API-Key: <plaintext>" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "u-1001", "limit": 10}' | jq .
```

```json
{
  "request_id": "a1b2c3d4e5f6",
  "recipe": "track_plays",
  "model_version": "sha256:a3f2...e91d",
  "items": [
    {"item_id": "trk-0142", "score": 0.91},
    {"item_id": "trk-8843", "score": 0.84}
  ]
}
```

::: tip Unknown users are expected
A user who was not in the training data returns `404 UNKNOWN_USER`. That is not a
server error — new users have no history to personalize on. Fall back to popular
items, or serve item-to-item results with `:recommend-related` seeded by whatever
the user is currently looking at. See the
[Serving API reference](/docs/serving-api).
:::

## Step 6 — Evaluate with ranking metrics

Because implicit feedback has no ratings, you evaluate the way search engines are
evaluated: with **ranking metrics** that ask "did the items the user actually
interacted with show up near the top of the list?" Recotem does this for you
during training. The `split` block holds out part of each user's history, every
Optuna trial ranks the held-out items, and each trial is scored by the recipe's
`metric` at `cutoff`:

- **`ndcg`** — normalized discounted cumulative gain; rewards putting relevant
  items higher in the list.
- **`recall`** — the fraction of held-out items that appear in the top-`cutoff`.
- **`map`** — mean average precision.
- **`hit`** — whether at least one relevant item made the cutoff.

The best trial's score is stored in the artifact and surfaced by the API. Fetch
it any time:

```bash
curl -s http://localhost:8080/v1/recipes/track_plays \
  -H "X-API-Key: <plaintext>" | jq '{best_algorithm, metric, cutoff, best_score}'
```

```json
{
  "best_algorithm": "IALSRecommender",
  "metric": "ndcg",
  "cutoff": 20,
  "best_score": 0.1723
}
```

Compare `best_score` across runs as you tune the recipe: raise `n_trials`, add or
remove algorithms, or switch the split scheme, and watch whether the held-out
score moves. Because `TopPop` is in the search, you always have a popularity
baseline to beat — if a personalized model cannot, the ranking metric will tell
you plainly.

::: warning Offline score ≠ business metric
A higher `ndcg` is a good sign, not a guarantee. Time-based splits reduce
look-ahead leakage, but the only ground truth is an online A/B test. Use the
offline metric to choose *between* candidates cheaply, then validate the winner
in production.
:::

## Next steps

- [Implicit vs Explicit Feedback](/learn/concepts/implicit-explicit-feedback) —
  the concept behind this workflow: why implicit signals dominate and how they
  change algorithm and metric choice.
- [Recommendations from Purchase Logs](/learn/use-cases/purchase-logs) — the same
  pattern applied end-to-end to e-commerce order data.
- [Product Recommendations from GA4 + BigQuery](/learn/use-cases/ga4-bigquery) —
  turn analytics events into interactions with a single SQL query, no CSV export.
- [CSV / Parquet Source](/docs/data-sources/csv) — every field, path scheme, and
  encoding option for the data source.
- [Recipe Reference](/docs/recipe-reference) — full field-level documentation for
  cleansing, splits, algorithms, and metrics.
- Back to the [Learn hub](/learn/).
