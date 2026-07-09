---
title: "Recommendation Metrics: nDCG, MAP, and Recall@K"
description: "Recommendation metrics explained — nDCG, MAP, Recall@K and Precision@K with formulas and a worked example, plus Recotem's metric and cutoff recipe fields."
---

# Recommendation Metrics: nDCG, MAP, and Recall@K

Before you ship a recommender, you need a number that tells you whether one model
is better than another. **nDCG**, **MAP**, and **Recall@K** are the standard
answers. They are *ranking* metrics: they score how well the top of a
recommendation list matches the items a user actually wanted. This page defines
each one, works a small example by hand, and shows exactly how Recotem uses the
`metric` and `cutoff` fields to pick a winning model.

## Why offline metrics

The gold standard for a recommender is an online A/B test — real users, real
clicks. But you cannot A/B test every hyperparameter of every candidate model:
it is slow, expensive, and risky to expose users to a bad ranking. So we run
**offline evaluation** first. Hold out some of each user's interactions, train on
the rest, ask the model to rank items, and check whether the held-out items came
back near the top. A single scalar — say nDCG@20 — lets an automated search
compare hundreds of models in minutes and promote only the best one to a live
test.

An offline metric is a *proxy*, not the truth. It rewards predicting the items a
user already interacted with, which is not identical to driving new engagement.
Treat a high offline score as necessary but not sufficient, and confirm the
winner online.

## The setup: relevant items and a top-K list

Every metric below compares two things for one user:

- The **relevant set** — the items held out for that user (the ground truth).
- The **top-K list** — the K items the model ranked highest, after removing items
  the user already interacted with in the training data.

A held-out item that shows up in the top-K list is a **hit**. Recommenders return
a ranked list, so *where* a hit lands matters — a relevant item at rank 1 is worth
more than the same item at rank 10. That ordering sensitivity is what separates
good ranking metrics from a plain hit count.

`K` is the **cutoff**: the list length you evaluate. Recotem calls it `cutoff`
and defaults it to 20.

## Recall@K and Precision@K

The two simplest metrics count hits, differing only in what they divide by.

```text
Recall@K    = (# relevant items in top-K) / (total # relevant items)
Precision@K = (# relevant items in top-K) / K
```

**Recall@K** answers "of everything the user wanted, how much did we surface in K
slots?" **Precision@K** answers "of the K things we showed, how many were wanted?"
Neither cares about the order inside the top-K — a hit at rank 1 and a hit at rank
K count the same. Both are between 0 and 1.

Precision and recall trade off against each other, which is why average precision
(below) folds them together across the whole list.

## MAP — Mean Average Precision

MAP rewards putting hits *early* by averaging the precision measured at each rank
where a hit occurs. For one user, **Average Precision at K** is:

```text
AP@K = (1 / min(R, K)) * sum over ranks k=1..K of ( Precision@k * rel_k )

  rel_k = 1 if the item at rank k is relevant, else 0
  R     = number of relevant items for this user
```

Only the ranks that are hits contribute (because `rel_k` zeroes out the misses),
and each hit is credited with the precision *at that depth*, so an early hit lifts
the score more than a late one. **MAP** is simply the mean of `AP@K` over all test
users. Like recall and precision, it lives in [0, 1].

## nDCG@K — the discounted gain metric

**nDCG** (normalized Discounted Cumulative Gain) is the most widely reported
ranking metric, and Recotem's default. It applies a smooth logarithmic discount
so that relevance found deeper in the list is worth progressively less.

Start with **DCG@K** — the sum of each item's gain divided by a rank discount:

```text
DCG@K = sum over ranks k=1..K of ( rel_k / log2(k + 1) )
```

For binary relevance `rel_k` is 0 or 1. The discount `log2(k+1)` grows with depth,
so rank 1 keeps its full gain (`log2(2) = 1`), rank 3 keeps half (`log2(4) = 2`),
and so on. DCG alone is unbounded and depends on how many relevant items a user
has, so we normalize by the **ideal DCG (IDCG@K)** — the DCG you would get if every
relevant item were ranked at the very top:

```text
IDCG@K = sum over ranks k=1..min(R, K) of ( 1 / log2(k + 1) )

nDCG@K = DCG@K / IDCG@K
```

Dividing by IDCG rescales every user onto a common [0, 1] axis, where 1.0 means a
perfect ranking. That per-user normalization is why nDCG is comparable across
users with very different numbers of relevant items.

## A worked example

Take a user with **3 relevant (held-out) items: A, B, C**, and `K = 5`. The model
returns this ranked list, where `X`, `Y`, `Z` are non-relevant items:

`[ A, X, B, Y, Z ]`

Two of the three relevant items are hits (A at rank 1, B at rank 3); C never
appears. Here is the DCG computation rank by rank:

| Rank k | Item | Relevant? | rel_k | Discount 1/log2(k+1) | Contribution |
|--------|------|-----------|-------|----------------------|--------------|
| 1 | A | yes | 1 | 1.000 | 1.000 |
| 2 | X | no  | 0 | 0.631 | 0.000 |
| 3 | B | yes | 1 | 0.500 | 0.500 |
| 4 | Y | no  | 0 | 0.431 | 0.000 |
| 5 | Z | no  | 0 | 0.387 | 0.000 |

`DCG@5 = 1.000 + 0.500 = 1.500`. The ideal ranking would place A, B, C in the top
three slots:

`IDCG@5 = 1/log2(2) + 1/log2(3) + 1/log2(4) = 1.000 + 0.631 + 0.500 = 2.131`

Now every metric for this user:

| Metric | Calculation | Value |
|--------|-------------|-------|
| Recall@5 | 2 hits / 3 relevant | 0.667 |
| Precision@5 | 2 hits / 5 slots | 0.400 |
| AP@5 | (1/3) × (Precision@1 + Precision@3) = (1/3) × (1.000 + 0.667) | 0.556 |
| nDCG@5 | 1.500 / 2.131 | 0.704 |

Notice how the metrics disagree on emphasis: precision is dragged down by the
three empty slots, recall ignores ordering entirely, and nDCG lands in between
because it was rewarded for the early hit at rank 1 but penalized for missing C.
Averaging each of these over all test users gives the dataset-level score.

## Ranking metrics vs rating metrics

The metrics above are **ranking metrics** — they judge an ordered list. A different
family, **rating metrics** like RMSE and MAE, judge predicted *scores*:

```text
RMSE = sqrt( mean( (predicted_rating - actual_rating)^2 ) )
```

Rating metrics come from the explicit-feedback era, where the task was to predict
a user's star rating for a movie. They measure numeric error and completely ignore
list order — a model can have a great RMSE and still rank the wrong items on top.

Modern recommenders, and Recotem, produce a **ranked top-K list**, so ranking
metrics are the right tool. Whether your signal is implicit (clicks, purchases) or
explicit (ratings), what you ultimately serve is an ordering — and Recall@K, MAP,
and nDCG@K score exactly that. See
[Implicit vs Explicit Feedback](/learn/concepts/implicit-explicit-feedback) for how
the feedback type shapes the whole pipeline.

## Train/test split and leakage caveats

An offline number is only trustworthy if the split that produced it is honest.
Watch for these traps:

- **Temporal leakage.** A random split can put a user's *future* interactions in
  the training set and their *past* in the test set — the model effectively peeks
  at the answer. To mimic production (predict the future from the past), use a
  time-based split. Recotem offers `time_user` (hold out each user's most recent
  interactions) and `time_global` (a single global time cutoff); see the
  [Recipe Reference](/docs/recipe-reference#training).
- **Already-seen items.** Items the user interacted with in training must be
  excluded from the recommendation list before scoring, or the model gets credit
  for "recommending" what the user already has. Recotem's evaluation handles this.
- **Popularity bias.** Recommending globally popular items scores deceptively well
  because popular items are, by definition, in many users' held-out sets. Always
  include a popularity baseline (Recotem's `TopPop`) in the search so you can see
  how much your fancier model actually beats it.
- **Tuning on the evaluation set.** The score a hyperparameter search maximizes is
  a *validation* estimate. It is optimistic by construction — you selected the model
  that looked best on that exact split. Confirm the winner on a live A/B test before
  trusting the absolute number.

The [Evaluate a Recommender](/learn/how-to/evaluate) how-to walks through choosing a
split scheme in practice.

## How Recotem uses `metric` and `cutoff`

In a Recotem recipe, evaluation is configured with two fields in the `training`
block. `metric` selects which ranking metric the Optuna search maximizes, and
`cutoff` sets the K it is measured at:

```yaml
training:
  algorithms: [IALS, RP3beta, TopPop]
  metric: ndcg      # ndcg | map | recall | hit  (default: ndcg)
  cutoff: 20        # list length K for evaluation (default: 20, must be >= 1)
  split:
    scheme: time_user
    heldout_ratio: 0.1
    seed: 42
```

The `metric` field accepts exactly four values:

| `metric` | Optimizes | Use when |
|----------|-----------|----------|
| `ndcg` | nDCG@cutoff | You care about ordering quality near the top — the sensible default. |
| `map` | MAP@cutoff | You want early hits rewarded but prefer average precision's framing. |
| `recall` | Recall@cutoff | You only care whether relevant items appear in K slots, order aside. |
| `hit` | Hit-rate@cutoff | You only need *at least one* relevant item in the top-K per user. |

During `recotem train`, Optuna runs a search across your `algorithms`, evaluates
every trial against the held-out split with the chosen `metric` at `cutoff`, and
keeps the highest-scoring model. That winning value is written into the signed
artifact's header as `best_score` (alongside `metric` and `cutoff`), so you can
read back exactly how the deployed model scored without loading the payload:

```bash
recotem inspect artifacts/purchase_history.recotem
```

Because the score is stored with the metric and cutoff it was measured at, you can
compare two artifacts meaningfully only when both were trained with the same
`metric` and `cutoff`. Every field is documented in the
[Recipe Reference](/docs/recipe-reference#training).

## Next steps

- [What Is a Recommendation System?](/learn/concepts/recommendation-system) — the
  pillar overview of how the pieces fit together.
- [Evaluate a Recommender](/learn/how-to/evaluate) — split strategies and offline
  evaluation, step by step.
- [Build a Recommendation System in Python](/learn/how-to/build-in-python) — the
  full train → evaluate → serve path with real commands.
- [Recipe Reference](/docs/recipe-reference#training) — every `training` field,
  including `metric`, `cutoff`, and the split schemes.
- Back to the [Learn hub](/learn/).
