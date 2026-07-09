---
title: What Is a Recommendation System?
description: A recommendation system (recommender system) predicts what a user wants next. Learn the types, signals, offline-to-online pipeline, and how Recotem builds one.
---

# What Is a Recommendation System?

A **recommendation system** — also called a **recommender system** — is
software that predicts which items a particular user is most likely to want
next, then presents a short, ranked list of them. Instead of making a person
search a catalog of thousands or millions of items, the system surfaces the few
that fit that person's tastes and context. "Customers who bought this also
bought…", a personalized homepage row, a "Recommended for you" feed, and
"related articles" at the bottom of a page are all recommendation systems at
work.

Formally, a recommender learns from a history of **interactions** — who engaged
with what — and produces a scoring function. Given a user, it scores every
candidate item and returns the top *K* by score. The whole discipline is about
learning that scoring function well from data you already have, and serving it
fast enough to answer a request while a page loads.

## Where recommendation systems are used

Recommenders appear anywhere a catalog is larger than a person can browse:

- **E-commerce** — product recommendations, cross-sell and up-sell, "frequently
  bought together". See [Recommendations from Purchase Logs](/learn/use-cases/purchase-logs).
- **Media and streaming** — the next video, song, or article to watch, listen
  to, or read.
- **News and content** — related-article modules and personalized feeds.
- **Marketplaces and classifieds** — matching listings to browsing behavior.
- **B2B and SaaS** — suggesting templates, integrations, or documents a user is
  likely to need.

The common thread is a **long tail**: a handful of popular items get most of the
attention by default, and a good recommender is what lets the rest of the
catalog find its audience.

## Types of recommenders

There are three broad families, distinguished by what signal they learn from.

### Content-based filtering

Content-based methods recommend items **similar to ones the user already liked**,
where similarity is measured from item attributes — a movie's genre, a product's
category, an article's text. If you read several articles tagged "kubernetes",
a content-based system recommends more "kubernetes" articles. It needs rich item
features and works for brand-new items, but it tends to keep users inside a
narrow bubble of what they have already seen.

### Collaborative filtering

Collaborative filtering (CF) ignores item attributes and learns purely from the
**pattern of interactions across many users**: "people who behaved like you also
engaged with these items." It can surface genuinely surprising, cross-category
recommendations because it exploits the wisdom of the crowd rather than explicit
tags. CF is the workhorse of modern recommenders and the approach Recotem is
built around — see [Collaborative Filtering Explained](/learn/concepts/collaborative-filtering).

### Hybrid systems

Hybrids combine both — for example, using collaborative filtering for users with
history and falling back to content-based or popularity recommendations for the
**cold-start** case (new users or new items with no interaction data yet).
Large production systems are almost always hybrid in practice.

::: tip Where Recotem sits
Recotem's algorithms are collaborative-filtering models: they learn from the
interaction matrix (who touched what), not from item text or images. Item
metadata such as titles and categories can be attached to *enrich the response*
(so the API returns readable fields), but it does not feed the model. If your
recommendations must reason over item content itself, that is a content-based or
hybrid problem outside Recotem's core.
:::

## Explicit vs. implicit signals

Every recommender learns from **feedback**, and feedback comes in two forms.

- **Explicit feedback** is a deliberate rating: a 5-star review, a thumbs
  up/down, a like. It is precise but rare — most users never rate anything, and
  the ratings that exist are biased toward extremes.
- **Implicit feedback** is a behavioral trace: a click, a view, a purchase, a
  play, a dwell. It is abundant and always-on, but noisy — a click is not a
  guaranteed endorsement, and the *absence* of a click is not a clear "no".

In practice, implicit feedback dominates because it is a byproduct of normal
usage: you already log purchases and page views. The trade-off shapes both which
algorithm you pick and how you evaluate it. Recotem is designed around implicit
interaction data — each row is simply "this user touched this item" — which is
why its recommended algorithms (IALS, RP3beta) are implicit-feedback models. For
the full treatment, see [Implicit vs. Explicit Feedback](/learn/concepts/implicit-explicit-feedback).

## The offline-to-online pipeline

Almost every production recommender splits into two phases.

**Offline (training):**

1. **Collect interactions** into a table of `(user, item[, timestamp])` rows.
2. **Clean** the data — drop null IDs, de-duplicate repeated pairs, enforce
   minimum size.
3. **Split** into train and held-out sets so you can measure quality honestly.
4. **Train and tune** one or more algorithms, searching hyperparameters.
5. **Evaluate** each candidate on the held-out set with a ranking metric such as
   nDCG@K or Recall@K, and keep the best model. See
   [Recommender Metrics](/learn/concepts/evaluation-metrics).
6. **Export** the winning model as a deployable file.

**Online (serving):**

7. **Load** the trained model behind an API.
8. **Answer requests** in real time: given a `user_id`, return the top-*K* items.

The offline phase is heavy and periodic (rerun nightly or weekly as new data
arrives). The online phase is light and constant. Keeping them separate means
you can retrain on a big machine without ever taking the live API down.

## How Recotem implements each stage

Recotem maps this pipeline onto three commands and one file. A single YAML
**recipe** is the source of truth: one recipe defines one model and one
`/v1/recipes/{name}:recommend` endpoint. `recotem train` runs the offline phase
and writes a signed artifact; `recotem serve` runs the online phase by loading
that artifact. The two sides communicate only through the artifact file, so they
can run on different machines.

Here is a minimal, real recipe covering the whole pipeline:

```yaml
name: news_articles

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
  path: ./artifacts/news_articles.recotem
  versioning: append_sha
```

Each block is one pipeline stage:

- **`source`** — where the interactions come from (`csv`, `parquet`, `bigquery`,
  or `sql`). This is *collect*.
- **`schema`** — which columns are the user, item, and timestamp.
- **`cleansing`** — null-drop, de-dup, and minimum-size gates. This is *clean*.
- **`training`** — the candidate `algorithms`, the offline `metric` and `cutoff`
  to optimize, the Optuna trial budget (`n_trials`), and the `split` scheme.
  This is *split + train + tune + evaluate* in one block. `IALS`, `RP3beta`, and
  `TopPop` are three of Recotem's built-in algorithms (the full set also
  includes `CosineKNN`, `DenseSLIM`, `TruncatedSVD`, and `BPRFM`).
- **`output`** — where the winning model is written as a signed artifact. This
  is *export*.

Run the offline phase:

```bash
recotem train recipes/news_articles.yaml
```

Recotem fetches the data, cleanses it, runs an Optuna search across the three
algorithms scored by nDCG@20 on the held-out split, and writes the best model to
`./artifacts/` as a signed binary artifact. Then start the online phase:

```bash
recotem serve --recipes ./recipes/
```

The server HMAC-verifies the artifact, loads it, and exposes the recommendation
endpoint. Ask it for a user's top items:

```bash
curl -s -X POST http://localhost:8080/v1/recipes/news_articles:recommend \
  -H "X-API-Key: <plaintext>" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "u1", "limit": 10}' | jq .
```

```json
{
  "request_id": "a1b2c3d4e5f6",
  "recipe": "news_articles",
  "model_version": "sha256:a3f2...e91d",
  "items": [
    {"item_id": "item-42", "score": 0.91},
    {"item_id": "item-17", "score": 0.84}
  ]
}
```

That is a complete recommendation system: interactions in, a ranked list out,
served over HTTP. The [Serving API](/docs/serving-api) also provides
`:recommend-related` for item-to-item "related items" queries and batch verbs
for scoring many users at once.

::: warning New users return 404
A `user_id` not seen during training returns `404 UNKNOWN_USER`. This is
expected — it is the cold-start case. Handle it in your application by falling
back to popular items or to a `:recommend-related` query seeded by whatever the
user is currently looking at.
:::

## Next steps

- [Collaborative Filtering Explained](/learn/concepts/collaborative-filtering) —
  the family of algorithms Recotem is built on, in depth.
- [Implicit vs. Explicit Feedback](/learn/concepts/implicit-explicit-feedback) —
  which signal you have and why it changes your algorithm choice.
- [Recommender Metrics](/learn/concepts/evaluation-metrics) — nDCG, MAP, and
  Recall@K, and how to read them.
- [Build a Recommendation System in Python](/learn/how-to/build-in-python) — the
  end-to-end how-to, from raw interactions to a served API.
- [Guide overview](/guide/) — install Recotem and follow the hands-on tutorial.
- [Recipe Reference](/docs/recipe-reference) — every recipe field, type,
  default, and validation rule.
- Back to the [Learn hub](/learn/).
