---
title: Collaborative Filtering Explained (Implicit vs Explicit)
description: "How collaborative filtering works: user-based and item-based methods, matrix factorization, implicit vs explicit feedback, and pitfalls like cold start."
---

# Collaborative Filtering Explained (Implicit vs Explicit)

**Collaborative filtering (CF)** is the algorithm family behind most production
recommendation engines. Its premise: you can predict what a user will like from
the behavior of *other users*, without knowing anything about the items
themselves. No product descriptions, no category taxonomy, no user profiles —
just the interaction log of who did what.

That minimalism is why CF is usually the first thing to try. Every shop,
publisher, and app already has interaction data, and on that data well-tuned
classical CF remains remarkably hard to beat. This page explains how the main
CF approaches work, why **implicit feedback** dominates in practice, and the
pitfalls — cold start, sparsity, popularity bias — you should plan for.

If you want the broader context first (what a recommender is, the full data →
training → serving pipeline), start with
[What Is a Recommendation Engine?](/learn/basics/what-is-a-recommendation-engine).

## The interaction matrix

Every CF method starts from the same mental picture: a giant matrix with one
row per user and one column per item. A cell holds the user's feedback on that
item — and almost every cell is empty, because each user has touched only a
tiny fraction of the catalog. CF's job is to predict which empty cells hide the
highest interest, using the patterns in the filled ones.

What goes into a filled cell defines the two feedback regimes:

- **Explicit feedback** — the user states a preference: a 4-star rating, a
  thumbs-down. The value is graded (likes *and* dislikes), but coverage is
  poor: only a small minority of users rate, and raters are not a
  representative sample.
- **Implicit feedback** — behavior observed in passing: a purchase, a click, a
  play, an add-to-cart. There are no negative signals (an unbought item may be
  disliked — or simply never seen), and no scale, just presence. But there is
  *lots* of it, for essentially every active user.

The research literature grew up on explicit ratings; production systems run
overwhelmingly on implicit feedback, because purchases and clicks are the data
businesses actually have. This changes the math: instead of predicting a
rating value, implicit-feedback models rank items by confidence that the user
would interact with them, treating observed pairs as positives and everything
else as unobserved rather than negative. Algorithms designed for ratings often
transfer poorly, which is why dedicated implicit-feedback models exist.

## Neighborhood methods: user-based and item-based

The earliest and most intuitive CF methods work directly with similarity
between rows or columns of the matrix.

**User-based CF** finds users whose interaction history overlaps with yours —
your "taste neighbors" — and recommends what they have that you don't. It is
easy to explain, but user neighborhoods are unstable (a user's row changes
with every session) and computing user-user similarity at scale is expensive
when you have millions of users.

**Item-based CF** flips the axis: two items are similar if largely the same
users interact with both. At request time, take the items in the user's
history and recommend the items most similar to them. Item-item similarities
are far more stable than user-user ones, can be precomputed offline, and
directly power the classic "customers who bought this also bought…" widget —
which is item-based CF applied to a single seed item. Similarity is typically
cosine over the interaction columns, sometimes with weighting to damp
ultra-popular items; graph/random-walk variants such as **RP3beta** extend the
same idea and are strong on co-purchase data.

## Matrix factorization

Neighborhood methods compare raw interaction vectors. **Matrix factorization
(MF)** goes further: it *learns* a compact representation. Each user and each
item gets a short vector of latent factors — say 64 numbers — such that the
dot product of a user vector and an item vector approximates the user's
affinity for that item. The factors are not hand-designed; they emerge from
the data, and often end up encoding recognizable dimensions like price
sensitivity or genre.

For implicit feedback the standard workhorse is **iALS** (implicit Alternating
Least Squares): it treats every observed interaction as a positive with a
confidence weight and every unobserved pair as a weak negative, then
alternates between solving for user factors and item factors until they
converge. Ranking-loss alternatives like **BPR** (Bayesian Personalized
Ranking) instead optimize pairwise order — observed items should score above
unobserved ones. Item-embedding models such as truncated SVD and (dense)
SLIM-style linear models round out the classical toolbox.

MF generalizes better than pure neighborhood methods on sparse data, because
the low-dimensional factors force the model to compress patterns rather than
memorize co-occurrences. The cost is interpretability and a real
hyperparameter surface — factor count, regularization, confidence weighting —
that genuinely moves ranking quality, which is why serious pipelines tune it
per dataset rather than copying defaults.

## Practical pitfalls

CF's failure modes are well known. Plan for them up front.

- **Cold-start users.** A brand-new user has no history, so pure CF has
  nothing to work with. Standard fallbacks: popular items, or item-to-item
  recommendations seeded by whatever the user is currently viewing (which
  needs no history at all).
- **Cold-start items.** A new item nobody has touched cannot be recommended by
  CF. Content-based methods or manual placement carry new items until they
  accumulate interactions — a natural hybrid.
- **Sparsity.** With millions of users and items, typical matrices are more
  than 99% empty. Very thin data favors simpler models — an item-KNN or even
  a popularity baseline can beat MF when there is not enough signal to
  estimate latent factors. This is an empirical question: evaluate several
  algorithms on *your* data instead of assuming.
- **Popularity bias.** Interaction data is dominated by popular items, and
  naive CF happily amplifies that, recommending bestsellers to everyone.
  Counter-measures include similarity damping (RP3beta's β parameter exists
  for exactly this), and always comparing your model against a popularity
  baseline — if tuned CF cannot beat "just recommend the top sellers", the
  personalization is not yet paying for itself.
- **Feedback loops.** Once recommendations drive clicks, tomorrow's training
  data reflects today's model. Keep some non-personalized surfaces or
  exploration in the mix, and measure with A/B tests rather than offline
  metrics alone.

## Collaborative filtering in practice with Recotem

Everything above is exactly the territory [Recotem](/docs/) packages.
Recotem is built on [irspack](https://github.com/tohtsky/irspack), a fast
C++/Eigen library specialized in **implicit-feedback** collaborative
filtering — the regime your purchase and click logs are in. A recipe lists
which CF algorithms to try, and the built-in Optuna search tunes each and
keeps the best by an offline ranking metric:

```yaml
name: purchase_log
source:
  type: csv
  path: ./interactions.csv
schema:
  user_column: user_id
  item_column: item_id
training:
  algorithms: [IALS, CosineKNN, RP3beta, TopPop]
  metric: ndcg
  n_trials: 40
output:
  path: ./artifacts/purchase_log.recotem
```

The algorithm names map directly onto this page: `IALS` is implicit-feedback
matrix factorization, `CosineKNN` is item-based neighborhood CF, `RP3beta` is
the popularity-damped graph variant, and `TopPop` is the popularity baseline
every experiment should include. `DenseSLIM` and `TruncatedSVD` are also
available, as is `BPRFM` (BPR-loss factorization) once `lightfm` is installed
alongside Recotem — see the
[Recipe Reference](/docs/recipe-reference#training) for the full list and
[Installation](/guide/installation#optional-extras) for the `BPRFM` caveat. The
cold-start fallbacks are built into the serving API too: unknown users return
an explicit `404 UNKNOWN_USER` so your application can fall back, and
[`:recommend-related`](/docs/serving-api#post-v1-recipes-name-recommend-related)
serves item-to-item recommendations that work for anonymous visitors.

## Next steps

- [What Is a Recommendation Engine?](/learn/basics/what-is-a-recommendation-engine) —
  the full pipeline this algorithm family plugs into.
- [Recommendations from Purchase Logs](/learn/use-cases/purchase-logs) — apply
  implicit-feedback CF to a real e-commerce order log, end to end.
- [Recotem vs LightFM vs implicit](/learn/compare/python-libraries) — how the
  main Python CF libraries compare if you want to build closer to the metal.
- [Recipe Reference](/docs/recipe-reference) — every training, tuning, and
  evaluation field.
- Back to the [Learn hub](/learn/).
