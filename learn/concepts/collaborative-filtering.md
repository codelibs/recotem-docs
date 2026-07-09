---
title: Collaborative Filtering Explained
description: "Collaborative filtering explained: how user-based, item-based, and matrix-factorization (iALS) recommenders learn from interactions, plus cold-start caveats."
---

# Collaborative Filtering Explained

**Collaborative filtering (CF)** is the workhorse behind "customers who bought
this also bought…" and "users like you also watched…". Instead of analysing what
an item _is_ — its genre, price, or text description — collaborative filtering
learns from _behaviour_: the pattern of who interacted with what. If two people
bought many of the same products, then the things one of them bought and the
other has not yet seen become strong recommendation candidates. That single
idea, applied across millions of users and items, powers most of the
personalized recommendations you see every day.

This page explains how CF works, the main families of CF algorithms, where each
one breaks down, and which of them [Recotem](/learn/) exposes. For the wider
landscape of recommender approaches, see
[What Is a Recommendation System?](/learn/concepts/recommendation-system).

## The core idea

Collaborative filtering starts from a single data structure: the
**user–item interaction matrix**. Rows are users, columns are items, and a cell
is filled in when a user interacted with an item — a purchase, a click, a play,
a rating. The matrix is almost always _sparse_: any given user has touched a
tiny fraction of the catalogue, so the overwhelming majority of cells are empty.

The recommender's job is to guess which of those empty cells should be filled.
It never reads the item's title or category — only the shape of the interactions.
The name "collaborative" captures the mechanism: users implicitly collaborate by
leaving behavioural traces, and each user benefits from the traces of everyone
who behaved similarly.

Because CF ignores item content entirely, it has a defining strength and a
defining weakness. The strength: it can surface genuinely surprising, cross-
category recommendations that a content-based system would never connect — the
classic "people who bought this drill also bought this specific coffee". The
weakness: it knows nothing about an item until people start interacting with it.

## A worked intuition example

Take four users and five movies. A check mark means the user watched the film.

| User | Heat | Casino | The Matrix | Inception | Amélie |
|------|:----:|:------:|:----------:|:---------:|:------:|
| Ana  | Yes  | Yes    | Yes        |           |        |
| Ben  | Yes  | Yes    |            |           |        |
| Cara |      |        | Yes        | Yes       |        |
| Dan  |      |        |            |           | Yes    |

What should we recommend to **Ben**? Ben has watched _Heat_ and _Casino_. Ana
watched both of those _and_ _The Matrix_. Ana and Ben overlap heavily, so Ana is
Ben's nearest neighbour — and the obvious suggestion for Ben is the film Ana
liked that Ben has not seen: **The Matrix**.

Notice what we did _not_ use: no genre, no director, no synopsis. We only counted
co-occurrence. That is collaborative filtering in miniature. Dan, who shares no
films with anyone, is the hard case — the cold-start problem we return to below.

## User-based vs item-based

There are two symmetric ways to read that matrix.

- **User-based CF** answers "who is like me?" It finds users whose interaction
  histories resemble yours, then recommends the items those neighbours liked that
  you have not seen. The example above is user-based: we found that Ana resembles
  Ben, then borrowed Ana's extra film.
- **Item-based CF** answers "what is like what I liked?" It computes similarity
  _between items_ from the columns of the matrix — two items are similar if the
  same users tend to interact with both — then recommends items similar to the
  ones you already engaged with. Here, _Heat_ and _Casino_ are similar because Ana
  and Ben both watched them, so a fan of _Heat_ gets _Casino_.

Item-based CF became the industry default for a practical reason: in most
catalogues, item–item relationships are far more stable than user–user ones. A
user's taste shifts week to week, but the fact that two products are frequently
bought together holds steady. The item–item similarity matrix can be precomputed
and reused, which makes item-based CF fast to serve at scale.

## Memory-based vs model-based

A second, more important axis is _how_ the similarities are computed.

### Memory-based (neighbourhood) methods

Memory-based CF works directly on the raw matrix. It computes similarity scores —
cosine similarity is the classic choice — between rows (user-based) or columns
(item-based), keeps each item's or user's nearest neighbours, and produces
recommendations as a weighted blend of what those neighbours liked. There is no
"training" in the machine-learning sense; the model _is_ the stored matrix plus a
similarity function. Neighbourhood methods are transparent and easy to reason
about ("recommended because you watched X"), but the pairwise similarity
computation can get expensive, and they struggle to generalise across items that
never co-occur, even when those items are conceptually related.

### Model-based methods (matrix factorization, iALS)

Model-based CF learns a compact statistical model that _explains_ the observed
interactions and can predict the unobserved ones. The dominant family is
**matrix factorization (MF)**. It assumes each user and each item can be
described by a short vector of hidden factors — a _latent embedding_ — and that a
user's affinity for an item is the dot product of their two vectors. Training
finds the embeddings that best reconstruct the known interactions.

Those latent factors are learned, not labelled, but they often line up with
recognisable concepts: a dimension might come to represent "action intensity" or
"art-house sensibility". Two items land near each other in the latent space when
many users treat them alike — even if _no single user_ interacted with both — so
factorization generalises further than a raw neighbourhood count.

For behavioural data, the most important MF variant is **implicit Alternating
Least Squares (iALS)**. Ordinary MF was designed for explicit star ratings, where
an empty cell means "not rated". But clicks and purchases give only positive
signals — an empty cell is ambiguous (did the user dislike the item, or just
never see it?). iALS handles this by treating every interaction as _positive with
a confidence weight_ and every blank as a weak negative, then alternately solving
for the user factors and the item factors in closed form until they converge. The
difference between implicit and explicit signals is important enough to have its
own page: [Implicit vs Explicit Feedback](/learn/concepts/implicit-explicit-feedback).

## The cold-start problem

Pure collaborative filtering has one structural blind spot: it needs interaction
history to work. This shows up as the **cold-start problem**, in three flavours:

- **New item.** An item nobody has interacted with has an empty column, so CF has
  nothing to compare it against and it never gets recommended — a chicken-and-egg
  trap for fresh inventory.
- **New user.** A user with no history (Dan, above) has an empty row, so there are
  no neighbours to borrow from. Systems usually fall back to non-personalized
  popularity until enough signal accumulates.
- **Sparse tail.** Even established users and long-tail items with only a handful
  of interactions get noisy, low-confidence recommendations.

The common mitigations are to blend in a **content-based** signal (item metadata,
which _does_ describe new items) to form a **hybrid** recommender, and to serve a
**popularity baseline** for anyone the model cannot personalize for yet. A good
popularity fallback is not a consolation prize — for brand-new users it is often
the strongest thing you can show.

## Collaborative filtering in Recotem

Recotem is built on [irspack](https://github.com/tohtsky/irspack), and every
algorithm it trains is a collaborative-filtering model over your interaction
matrix. You do not implement any of the above — you list candidate algorithms in
a recipe and let a tuned search pick the winner. The CF algorithms most relevant
here are:

- **`IALS`** — implicit Alternating Least Squares, the model-based matrix
  factorization described above. It learns latent user and item embeddings from
  implicit signals with confidence weighting. This is usually the strongest
  general-purpose choice for click/purchase data.
- **`CosineKNN`** — item-based, memory-based CF. It builds an item–item
  similarity matrix using cosine similarity over the interaction columns and
  recommends items nearest to those you engaged with. Transparent and a reliable
  baseline. (The alias `CosinekNN` is also accepted.)
- **`RP3beta`** — a graph-based neighbourhood method. It treats the user–item
  matrix as a bipartite graph and scores items by three-step random-walk
  transition probability, with a `beta` term that penalizes popular items so the
  recommendations are less dominated by blockbusters. It often outperforms plain
  cosine KNN on sparse implicit data.
- **`TopPop`** — not personalized at all, but the popularity baseline every CF
  system needs for cold-start users. Including it as a candidate gives the search
  an honest floor to beat.

Recotem does not force you to pick one. List several and Recotem runs a
multi-algorithm [Optuna](https://optuna.org/) search, tuning each and keeping the
model that scores best on your chosen [metric](/learn/concepts/evaluation-metrics):

```yaml
training:
  algorithms: [IALS, CosineKNN, RP3beta, TopPop]
  metric: ndcg
  cutoff: 20
  n_trials: 40
```

Because there is no universally best recommender, comparing a factorization model
(`IALS`), two neighbourhood models (`CosineKNN`, `RP3beta`), and a popularity
baseline (`TopPop`) in a single search is exactly the right instinct — the
validation metric, not intuition, decides. The other recipe fields, including the
full list of accepted algorithm names, are documented in the
[Recipe Reference](/docs/recipe-reference).

## Next steps

- [What Is a Recommendation System?](/learn/concepts/recommendation-system) —
  the pillar overview: content-based, collaborative, and hybrid approaches.
- [Implicit vs Explicit Feedback](/learn/concepts/implicit-explicit-feedback) —
  why iALS treats clicks and purchases differently from star ratings.
- [Recommender Metrics: nDCG, MAP, Recall@K](/learn/concepts/evaluation-metrics) —
  how Recotem decides which CF model won.
- [How to Build a Recommendation System in Python](/learn/how-to/build-in-python) —
  put IALS, CosineKNN, and RP3beta to work end to end.
- [Recipe Reference](/docs/recipe-reference) — every `training.algorithms` value
  and tuning field.
