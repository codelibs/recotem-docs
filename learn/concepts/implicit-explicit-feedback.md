---
title: Implicit vs. Explicit Feedback
description: Implicit feedback vs explicit feedback in recommender systems — how clicks, purchases, and views differ from star ratings, and why Recotem models implicit signals.
---

# Implicit vs. Explicit Feedback

Every recommender learns from a record of how people interacted with items. That
record comes in two flavours: **explicit feedback**, where users deliberately
state how much they like something, and **implicit feedback**, where preference
is *inferred* from ordinary behaviour. The distinction sounds academic, but it
drives almost every practical decision you make — which data you collect, which
algorithm you train, and even which evaluation metric tells you the truth. This
page explains both, why implicit feedback dominates real systems, and how
Recotem models it.

If you are new to the field, start with the pillar overview of
[what a recommendation system is](/learn/concepts/recommendation-system) and come
back here for the feedback distinction.

## Two kinds of signal

**Explicit feedback** is a preference the user consciously provides on a scale:

- 5-star ratings (movies, products, restaurants)
- Thumbs up / thumbs down
- Numeric review scores
- "Not interested" / "Show fewer like this"

The defining trait is intent: the user is *telling* you their opinion, usually
on an ordered scale, and a low rating is a genuine negative signal.

**Implicit feedback** is a preference *inferred* from behaviour the user did not
intend as a rating:

- Clicks and page views
- Purchases and add-to-cart events
- Song or video plays, watch time, dwell time
- Searches, bookmarks, follows

Here the signal is indirect. A purchase strongly suggests interest; a click is
weaker; a three-second video view is weaker still. Crucially, implicit data is
almost always **positive-only** — you see what users *did*, never an explicit "I
dislike this."

| | Explicit | Implicit |
|---|---|---|
| Example | 4-star rating | Purchase, click, play |
| User intent | Deliberate opinion | Behavioural trace |
| Scale | Ordered (1–5, ±1) | Presence / count |
| Negative signal | Yes (a 1-star is real) | No (absence is ambiguous) |
| Volume | Scarce | Abundant |
| Noise | Low per data point | Higher per data point |

## Why implicit feedback dominates in practice

Textbooks often open with the MovieLens star-ratings dataset, which can leave the
impression that explicit ratings are the norm. In production systems the opposite
is true — implicit feedback is what most teams actually have and use, for several
reasons:

- **Volume.** Every session generates clicks, views, and plays. Only a tiny
  fraction of users ever rate anything. Implicit logs can be orders of magnitude
  larger.
- **Always-on and free.** Implicit signals are collected automatically as a
  by-product of normal use. There is no UI to build, no user effort, no prompt to
  ignore.
- **Coverage.** Ratings are sparse and skewed toward a self-selected minority who
  bother to rate — often only after an unusually good or bad experience. Implicit
  data covers virtually every user and item that saw any traffic.
- **Freshness.** Behaviour reflects what users want *now*; a rating left two years
  ago may be stale.

The trade-off is that implicit feedback is noisier and one-class. A click might
be a misclick; a purchase might be a gift; and the fact that a user *never
watched* a film tells you almost nothing — maybe they disliked it, maybe they
simply never saw it. Handling that ambiguity is the central technical challenge of
implicit-feedback recommendation.

## The positive-only problem: confidence and negative sampling

With explicit ratings you can frame recommendation as *rating prediction*: given
the ratings a user gave, predict the rating they would give to an unseen item,
and minimise the error against held-out ratings. Implicit data has no such target
— there are no negative labels to regress against. Two families of techniques
turn positive-only behaviour into a trainable objective.

**Confidence weighting.** The classic approach (Hu, Koren & Volinsky, 2008,
the model behind implicit ALS) treats *every* user–item pair as a training
example: observed interactions are positives, and all the unobserved pairs are
treated as negatives — but weighted by a **confidence** that reflects how sure we
are. An item a user interacted with many times gets high positive confidence; the
enormous sea of unobserved items gets low, non-zero negative confidence. Nothing
is sampled away; the whole matrix contributes, with weights doing the work of
distinguishing "genuinely disliked" from "simply never seen."

**Negative sampling.** The other approach (used by BPR, Bayesian Personalized
Ranking) reframes the task as *pairwise ranking*: for each observed positive item,
randomly draw an unobserved item as a negative, and train the model so the
positive is ranked above the negative. Instead of weighting the entire unobserved
space, you *sample* a manageable number of negatives per step. This scales well
and directly optimises for ranking order.

Both share the same intuition: **an interaction is evidence of interest, and the
absence of an interaction is weak, uncertain evidence against it** — not a hard
"dislike." The two families just spend their compute differently: one weights all
negatives, the other samples a few.

## Implications for algorithm and metric choice

The feedback type you have should drive two decisions.

**Algorithm.** Rating-prediction algorithms designed to minimise error on a 1–5
scale are a poor fit when you only have clicks. You want models built for
one-class, positive-only data: confidence-weighted matrix factorization, item-item
similarity, graph/random-walk models, and pairwise-ranking learners. Feeding
binary "it happened" signals into a plain rating-regression model wastes the
structure of the problem.

**Metric.** This is the subtlety teams miss most often. With explicit ratings you
might report RMSE or MAE — the average error of predicted vs. actual ratings. That
metric is *meaningless* for implicit data: there is no true rating to be wrong
about. Implicit recommendation is a **top-K ranking** task — surface the handful
of items the user is most likely to engage with — so you evaluate it with ranking
metrics: **Recall@K**, **nDCG@K**, and **MAP**. These ask "did the items the user
actually interacted with show up near the top of the list?" See
[recommender evaluation metrics](/learn/concepts/evaluation-metrics) for the
definitions and formulas.

## How Recotem consumes implicit feedback

Recotem is built for implicit feedback from the ground up (it is powered by
[irspack](/learn/concepts/recommendation-system), an implicit-feedback recommender
library). You give it **interaction rows** — one row per (user, item) event — and
it treats the presence of each interaction as a positive signal. There is no
rating or score column in the schema; the fact that the interaction happened *is*
the data.

A minimal [CSV source](/docs/data-sources/csv) and
[schema](/docs/recipe-reference#schema) look like this:

```csv
user_id,item_id,timestamp
u-1001,item-8843,2026-05-01T09:12:00Z
u-1001,item-2290,2026-05-01T10:03:00Z
u-2087,item-8843,2026-05-02T18:40:00Z
```

```yaml
schema:
  user_column: user_id
  item_column: item_id
  time_column: timestamp   # used only for a time-based train/test split
```

Notice there is no place to put a star rating — because Recotem does not model
one. If your source has a `rating` or `quantity` column, it is simply ignored; the
[recipe](/docs/recipe-reference) maps only user, item, and (optionally) time. The
[`cleansing.dedup`](/docs/recipe-reference#cleansing) step collapses repeated
(user, item) pairs so the interaction matrix is effectively binary presence, which
is what implicit models expect.

Every algorithm Recotem can train operates on that implicit interaction matrix:

- **IALS** — implicit alternating least squares, the confidence-weighting model
  described above. A strong general-purpose baseline.
- **BPRFM** — a factorization machine trained with Bayesian Personalized Ranking,
  the negative-sampling / pairwise approach.
- **RP3beta** — a graph random-walk model that excels at "bought/viewed together"
  co-occurrence patterns.
- **CosineKNN**, **DenseSLIM**, **TruncatedSVD** — item-similarity, sparse linear,
  and latent-factor models, all fit directly on the binary matrix.
- **TopPop** — a non-personalized popularity baseline that gives the search a sane
  floor.

You list several in [`training.algorithms`](/docs/recipe-reference#training) and
Recotem's Optuna search tries each, keeping the best. Because the task is ranking,
the [`metric`](/docs/recipe-reference#training) field accepts `ndcg`, `map`,
`recall`, or `hit` with a `cutoff` (list length K) — exactly the ranking metrics
that make sense for implicit data, and never a rating-error metric like RMSE.

::: tip Absence is not dislike
When a Recotem model returns items a user has not interacted with, it is ranking
*candidates by inferred interest*, not predicting a rating. Use `exclude_items`
on the [recommend endpoint](/learn/use-cases/purchase-logs) to hide items the user
already has, rather than expecting the model to have "known" they were consumed.
:::

## Next steps

- [Implicit-Feedback Recommendations, Step by Step](/learn/how-to/implicit-feedback)
  — a full, runnable walkthrough from event log to served model.
- [Recommendations from Purchase Logs](/learn/use-cases/purchase-logs) — implicit
  feedback applied to e-commerce order data.
- [What Is a Recommendation System?](/learn/concepts/recommendation-system) — the
  pillar overview that puts feedback in context.
- [Recipe Reference](/docs/recipe-reference) — the `schema`, `cleansing`, and
  `training` fields referenced above.
- [CSV / Parquet Source](/docs/data-sources/csv) — how to shape interaction rows
  into a data source.
- Back to the [Learn hub](/learn/).
